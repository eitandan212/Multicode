import { createHash, randomUUID } from "node:crypto";
import type { Connection } from "../config.js";
import type { Provider } from "../providers/types.js";
import { CLI_KINDS, type CrewMember, type McpServer, type Plan, type PlanTask, type RunEvent, type Settings } from "../shared.js";
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
 * running task; a task with no declared files runs alone. `accepts` lets a task wait for a
 * specific worker (the dispatcher's pick). `exec` must not throw.
 */
export function scheduleTasks<W>(
  tasks: PlanTask[],
  workers: W[],
  exec: (t: PlanTask, w: W) => Promise<void>,
  accepts: (t: PlanTask, w: W) => boolean = () => true,
): Promise<void> {
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
    const start = (task: PlanTask, worker: W) => {
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
    };
    const pump = () => {
      if (!queue.length && running === 0) return resolve();
      let started = true;
      while (started) {
        started = false;
        for (let wi = 0; wi < idle.length; wi++) {
          const worker = idle[wi]!;
          const idx = queue.findIndex((t) => canRun(t) && accepts(t, worker));
          if (idx < 0) continue;
          idle.splice(wi, 1);
          start(queue.splice(idx, 1)[0]!, worker);
          started = true;
          break;
        }
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
  /** Shared MCP servers and their env values, handed to every CLI agent. */
  mcpServers?: McpServer[];
  env?: Record<string, string>;
  /** Watchdog limits for each agent call (defaults: 4 min silent, 15 min total). */
  limits?: { idleMs: number; maxMs: number };
}

/** What the run changed, so it can be undone later. */
export interface Checkpoint {
  files: { path: string; before: string | null; afterHash: string | null }[];
  /** Files that were binary or too large to keep a copy of. */
  skipped: string[];
}

export const hashText = (t: string | undefined | null) => (t == null ? null : createHash("sha256").update(t).digest("hex"));

const isCli = (m: ResolvedMember) => CLI_KINDS.includes(m.connection.kind);

/** Agent watchdog limits; overridable for slow local models. */
const DEFAULT_LIMITS = {
  idleMs: Number(process.env.MULTICODE_AGENT_IDLE_MS) || 4 * 60_000,
  maxMs: Number(process.env.MULTICODE_AGENT_MAX_MS) || 15 * 60_000,
};

export async function runCrew(o: RunOptions): Promise<{ summary: string; changedFiles: string[]; checkpoint: Checkpoint }> {
  const { workspace: ws, roles, emit, signal } = o;
  const limits = o.limits ?? DEFAULT_LIMITS;
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

  /**
   * One agent call, with guards: an agent that goes silent for `idleMs` or runs past
   * `maxMs` is stopped, so a stuck model can't hold the whole crew hostage.
   */
  const call = async (member: ResolvedMember, title: string, system: string, prompt: string, mode: "text" | "edit") => {
    const streamId = randomUUID();
    emit({ type: "agent.start", streamId, memberId: member.id, title });
    const local = new AbortController();
    const onRunAbort = () => local.abort();
    signal.addEventListener("abort", onRunAbort, { once: true });
    let reason = "";
    const stop = (why: string) => {
      reason = why;
      local.abort();
    };
    let idle = setTimeout(() => stop(`${member.name} went silent for ${Math.round(limits.idleMs / 60_000)} min`), limits.idleMs);
    const hard = setTimeout(() => stop(`${member.name} ran past ${Math.round(limits.maxMs / 60_000)} min`), limits.maxMs);
    try {
      const text = await member.provider.generate(
        { system, prompt, model: member.model, cwd: ws.root, mode, mcpServers: o.mcpServers, env: o.env },
        (t) => {
          clearTimeout(idle);
          idle = setTimeout(() => stop(`${member.name} went silent for ${Math.round(limits.idleMs / 60_000)} min`), limits.idleMs);
          emit({ type: "agent.delta", streamId, text: t });
        },
        local.signal,
      );
      emit({ type: "agent.end", streamId, ok: true });
      return text;
    } catch (err) {
      const message = reason && !signal.aborted ? `Stopped: ${reason}.` : (err as Error).message;
      emit({ type: "agent.end", streamId, ok: false, error: message });
      throw new Error(message);
    } finally {
      clearTimeout(idle);
      clearTimeout(hard);
      signal.removeEventListener("abort", onRunAbort);
    }
  };

  // 1. Plan
  emit({ type: "phase", phase: "planning", round: 0 });
  const archCtx = await ws.contextDigest(0);
  const smart = o.settings.dispatch === "smart" && roles.builders.length > 1;
  const builderIds = new Set(roles.builders.map((b) => b.id));
  const planText = await call(
    roles.architect,
    smart ? "Planning and dispatching" : "Planning the work",
    P.architectSystem(smart),
    P.architectPrompt(o.prompt, archCtx.tree, o.history, smart ? P.roster(roles.builders) : ""),
    "text",
  );
  const plan: Plan = parsePlan(planText, o.prompt);
  for (const t of plan.tasks) {
    if (!smart || !t.assignee || !builderIds.has(t.assignee)) {
      delete t.assignee;
      delete t.why;
    }
  }
  emit({ type: "plan", plan });
  checkAbort();

  // 2. Build (and later fix) in parallel
  let failures = 0;
  /** Who last wrote each file: review fixes go back to the agent that knows the file. */
  const owner = new Map<string, string>();
  // Each member contributes as many workers as it has parallel agents.
  const workers = roles.builders.flatMap((m) => Array.from({ length: Math.max(1, Math.min(4, m.agents ?? 1)) }, () => m));
  const build = async (tasks: PlanTask[], basePlan: Plan, attempt = 0): Promise<void> => {
    if (attempt === 0) failures = 0;
    const failed: { task: PlanTask; by: string }[] = [];
    tasks.forEach((t) => emit({ type: "task.status", taskId: t.id, status: "queued", memberId: t.assignee }));
    await scheduleTasks(
      tasks,
      workers,
      async (task, member) => {
        if (signal.aborted) return;
        emit({ type: "task.status", taskId: task.id, status: "running", memberId: member.id });
        // Fingerprint the files this task owns, to verify the agent really wrote them.
        const before = new Map<string, string | null>();
        for (const f of task.files) before.set(f, hashText(await ws.tryRead(f)));
        try {
          const cli = isCli(member);
          const ctx = cli ? { tree: (await ws.contextDigest(0)).tree, files: "" } : await ws.contextDigest(80_000, task.files);
          const reply = await call(
            member,
            attempt ? `${task.title} (retry)` : task.title,
            P.builderSystem(cli, member.instructions),
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
          if (task.files.length) {
            let touched = false;
            for (const f of task.files) if (hashText(await ws.tryRead(f)) !== before.get(f)) touched = true;
            if (!touched) throw new Error(`${member.name} finished without writing ${task.files.join(", ")}.`);
          }
          task.files.forEach((f) => owner.set(f, member.id));
          emit({ type: "task.status", taskId: task.id, status: "done", memberId: member.id });
        } catch (err) {
          await syncChanges(member.id);
          if (signal.aborted) return;
          failed.push({ task, by: member.id });
          emit({ type: "task.status", taskId: task.id, status: "failed", memberId: member.id, error: (err as Error).message });
        }
      },
      (task, member) => !task.assignee || task.assignee === member.id,
    );
    checkAbort();

    // One more chance for each failed task, preferably with a different agent.
    if (failed.length && attempt === 0) {
      const retries = failed.map(({ task, by }, i) => {
        const others = roles.builders.filter((b) => b.id !== by);
        const next = others.length ? others[i % others.length]! : roles.builders.find((b) => b.id === by)!;
        const name = roles.builders.find((b) => b.id === by)?.name ?? "The agent";
        return { ...task, assignee: next.id, why: next.id === by ? `Retrying after a failed attempt` : `Reassigned: ${name} didn't finish` };
      });
      emit({ type: "tasks.added", tasks: retries.map((t) => ({ ...t, id: `${t.id}-retry` })), round: 0 });
      await build(
        retries.map((t) => ({ ...t, id: `${t.id}-retry` })),
        basePlan,
        1,
      );
      return;
    }
    failures += failed.length;
  };

  emit({ type: "phase", phase: "building", round: 0 });
  await build(plan.tasks, plan);
  if (failures >= plan.tasks.length) throw new Error("Every build task failed — check the agent errors above.");
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
    const fixes = P.fixTasks(review.issues, round).map((t) => {
      const who = t.files.map((f) => owner.get(f)).find(Boolean);
      return who && builderIds.has(who) ? { ...t, assignee: who, why: "Wrote this file" } : t;
    });
    emit({ type: "tasks.added", tasks: fixes, round });
    await build(fixes, { summary: plan.summary, tasks: fixes });
  }

  await syncing;
  const changedFiles = [...changed].sort();
  emit({ type: "run.diff", files: await diffChanges(ws, baseline, changedFiles) });
  const summary = [plan.summary, reviewSummary].filter(Boolean).join("\n\n");

  const checkpoint: Checkpoint = { files: [], skipped: [] };
  for (const path of changedFiles) {
    const before = baseline.get(path);
    if (before === null) {
      checkpoint.skipped.push(path);
      continue;
    }
    checkpoint.files.push({ path, before: before ?? null, afterHash: hashText(await ws.tryRead(path)) });
  }
  return { summary: summary || "Done.", changedFiles, checkpoint };
}
