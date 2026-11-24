import { randomUUID } from "node:crypto";
import type { Connection } from "../config.js";
import type { Provider } from "../providers/types.js";
import { CLI_KINDS, type CrewMember, type Plan, type PlanTask, type RunEvent, type Settings } from "../shared.js";
import { Workspace, type FileSnapshot } from "../workspace.js";
import { captureBaseline, diffChanges } from "./diff.js";
import { parseFileOps, parsePlan, parseReview } from "./parse.js";
import * as P from "./prompts.js";

export interface ResolvedMember extends CrewMember {
  connection: Connection;
  provider: Provider;
}

export interface CrewRoles {
  architect: ResolvedMember;
  builders: ResolvedMember[];
  reviewer: ResolvedMember;
}

/** Fills empty roles so that any non-empty crew can run end to end. */
export function assignRoles(members: ResolvedMember[]): CrewRoles {
  if (!members.length) throw new Error("Connect at least one AI account and add it to your crew.");
  const by = (r: CrewMember["role"]) => members.filter((m) => m.role === r);
  const builders = by("builder").length ? by("builder") : members;
  const architect = by("architect")[0] ?? by("reviewer")[0] ?? builders[0]!;
  const reviewer = by("reviewer")[0] ?? by("architect")[0] ?? builders[builders.length - 1]!;
  return { architect, builders, reviewer };
}

/**
 * Runs tasks across workers in parallel. A task waits while any of its files is held by a
 * running task; a task with no declared files runs alone. `exec` must not throw.
 */
export function scheduleTasks<W>(tasks: PlanTask[], workers: W[], exec: (t: PlanTask, w: W) => Promise<void>): Promise<void> {
  const queue = [...tasks];
  const locked = new Set<string>();
  const idle = [...workers];
  let running = 0;
  let exclusive = false;

  const canRun = (t: PlanTask) => {
    if (exclusive) return false;
    if (!t.files.length) return running === 0;
    return t.files.every((f) => !locked.has(f));
  };

  return new Promise((resolve) => {
    const pump = () => {
      if (!queue.length && running === 0) return resolve();
      while (idle.length) {
        const idx = queue.findIndex(canRun);
        if (idx < 0) break;
        const task = queue.splice(idx, 1)[0]!;
        const worker = idle.shift()!;
        running++;
        if (!task.files.length) exclusive = true;
        task.files.forEach((f) => locked.add(f));
        void exec(task, worker)
          .catch(() => {})
          .finally(() => {
            running--;
            if (!task.files.length) exclusive = false;
            task.files.forEach((f) => locked.delete(f));
            idle.push(worker);
            pump();
          });
      }
    };
    pump();
  });
}

export interface RunOptions {
  prompt: string;
  history: string[];
  workspace: Workspace;
  roles: CrewRoles;
  settings: Settings;
  emit: (e: RunEvent) => void;
  signal: AbortSignal;
}

const isCli = (m: ResolvedMember) => CLI_KINDS.includes(m.connection.kind);

export async function runCrew(o: RunOptions): Promise<{ summary: string; changedFiles: string[] }> {
  const { workspace: ws, roles, emit, signal } = o;
  const changed = new Set<string>();
  let known: FileSnapshot = await ws.snapshot();
  const baseline = await captureBaseline(ws);
  let syncing: Promise<void> = Promise.resolve();

  const checkAbort = () => {
    if (signal.aborted) throw new Error("Cancelled");
  };

  /** Diffs the folder against the last known state and reports changes (serialised). */
  const syncChanges = (memberId: string) =>
    (syncing = syncing.then(async () => {
      const now = await ws.snapshot();
      for (const c of Workspace.diff(known, now)) {
        changed.add(c.path);
        emit({ type: "file.changed", path: c.path, change: c.change, memberId });
      }
      known = now;
    }));

  const call = async (member: ResolvedMember, title: string, system: string, prompt: string, mode: "text" | "edit") => {
    const streamId = randomUUID();
    emit({ type: "agent.start", streamId, memberId: member.id, title });
    try {
      const text = await member.provider.generate(
        { system, prompt, model: member.model, cwd: ws.root, mode },
        (t) => emit({ type: "agent.delta", streamId, text: t }),
        signal,
      );
      emit({ type: "agent.end", streamId, ok: true });
      return text;
    } catch (err) {
      emit({ type: "agent.end", streamId, ok: false, error: (err as Error).message });
      throw err;
    }
  };

  // 1. Plan
  emit({ type: "phase", phase: "planning", round: 0 });
  const archCtx = await ws.contextDigest(0);
  const planText = await call(
    roles.architect,
    "Planning the work",
    P.architectSystem(),
    P.architectPrompt(o.prompt, archCtx.tree, o.history),
    "text",
  );
  const plan: Plan = parsePlan(planText, o.prompt);
  emit({ type: "plan", plan });
  checkAbort();

  // 2. Build (and later fix) in parallel
  let failures = 0;
  const build = async (tasks: PlanTask[], basePlan: Plan) => {
    failures = 0;
    tasks.forEach((t) => emit({ type: "task.status", taskId: t.id, status: "queued" }));
    await scheduleTasks(tasks, roles.builders, async (task, member) => {
      if (signal.aborted) return;
      emit({ type: "task.status", taskId: task.id, status: "running", memberId: member.id });
      try {
        const cli = isCli(member);
        const ctx = cli ? { tree: (await ws.contextDigest(0)).tree, files: "" } : await ws.contextDigest(80_000, task.files);
        const reply = await call(
          member,
          task.title,
          P.builderSystem(cli),
          P.builderPrompt({ request: o.prompt, plan: basePlan, task, tree: ctx.tree, files: ctx.files }),
          "edit",
        );
        if (!cli) {
          const ops = parseFileOps(reply);
          if (!ops.length) throw new Error("Builder returned no file changes.");
          for (const op of ops) {
            if (op.change === "write") await ws.write(op.path, op.content ?? "");
            else await ws.remove(op.path);
          }
        }
        await syncChanges(member.id);
        emit({ type: "task.status", taskId: task.id, status: "done", memberId: member.id });
      } catch (err) {
        failures++;
        await syncChanges(member.id);
        emit({ type: "task.status", taskId: task.id, status: "failed", memberId: member.id, error: (err as Error).message });
      }
    });
    checkAbort();
  };

  emit({ type: "phase", phase: "building", round: 0 });
  await build(plan.tasks, plan);
  if (failures === plan.tasks.length) throw new Error("Every build task failed — check the agent errors above.");
  await syncing;
  if (!changed.size) throw new Error("The builders finished without changing any files in the project.");

  // 3. Review loop
  let reviewSummary = "";
  for (let round = 1; round <= o.settings.maxReviewRounds; round++) {
    emit({ type: "phase", phase: "reviewing", round });
    const reviewerCtx = isCli(roles.reviewer)
      ? { tree: (await ws.contextDigest(0)).tree, files: "(read the files from the current directory)" }
      : await ws.contextDigest(120_000, [...changed]);
    const reviewText = await call(
      roles.reviewer,
      round === 1 ? "Reviewing the build" : `Re-review (round ${round})`,
      P.reviewerSystem(),
      P.reviewerPrompt(o.prompt, plan, reviewerCtx.tree, reviewerCtx.files),
      "text",
    ).catch((err: Error) => {
      // A failing reviewer should not throw away finished work.
      checkAbort();
      return JSON.stringify({ approved: true, summary: `Review skipped: ${err.message}`, issues: [] });
    });
    const review = parseReview(reviewText);
    reviewSummary = review.summary;
    emit({ type: "review", review, round });
    checkAbort();
    if (review.approved || round === o.settings.maxReviewRounds) break;

    emit({ type: "phase", phase: "fixing", round });
    const fixes = P.fixTasks(review.issues, round);
    emit({ type: "tasks.added", tasks: fixes, round });
    await build(fixes, { summary: plan.summary, tasks: fixes });
  }

  await syncing;
  const changedFiles = [...changed].sort();
  emit({ type: "run.diff", files: await diffChanges(ws, baseline, changedFiles) });
  const summary = [plan.summary, reviewSummary].filter(Boolean).join("\n\n");
  return { summary: summary || "Done.", changedFiles };
}
