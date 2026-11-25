import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

/** A unified diff without the "Index:" / "====" header lines. */
const patchOf = (...args: Parameters<typeof createTwoFilesPatch>) =>
  createTwoFilesPatch(...args).split("\n").slice(2).join("\n");
import type { Approvals } from "../approvals.js";
import type { Connection } from "../config.js";
import {
  isLimitError,
  limitCooldownMs,
  type Provider,
} from "../providers/types.js";
import {
  AGENT_KINDS,
  type CrewMember,
  type DesignVariant,
  type ApprovalAsk,
  type FileDiff,
  type McpServer,
  type Plan,
  type PlanTask,
  type RunEvent,
  type Settings,
} from "../shared.js";
import { Workspace, type FileSnapshot } from "../workspace.js";
import { captureBaseline, diffChanges } from "./diff.js";
import { extractJson, parseFileOps, parsePlan, parseReview } from "./parse.js";
import * as P from "./prompts.js";

export interface ResolvedMember extends CrewMember {
  connection: Connection;
  provider: Provider;
}

export interface CrewRoles {
  architect: ResolvedMember;
  builders: ResolvedMember[];
  /** The lead reviewer (first of `reviewers`). */
  reviewer: ResolvedMember;
  /** Every reviewer; they review in parallel each round (e.g. code + security). */
  reviewers?: ResolvedMember[];
}

/** Fills empty roles so that any non-empty crew can run end to end. */
export function assignRoles(members: ResolvedMember[]): CrewRoles {
  if (!members.length)
    throw new Error("Connect at least one AI account and add it to your crew.");
  const by = (r: CrewMember["role"]) => members.filter((m) => m.role === r);
  const builders = by("builder").length ? by("builder") : members;
  const architect = by("architect")[0] ?? by("reviewer")[0] ?? builders[0]!;
  const reviewer =
    by("reviewer")[0] ?? by("architect")[0] ?? builders[builders.length - 1]!;
  const reviewers = by("reviewer").length ? by("reviewer") : [reviewer];
  return { architect, builders, reviewer, reviewers };
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
  /** Skill-pack instructions for API agents (CLI agents load skills from their folders). */
  skillText?: string;
  /** Watchdog limits for each agent call (defaults: 4 min silent, 15 min total). */
  limits?: { idleMs: number; maxMs: number };
  /** Free model that takes over when an account hits its usage limit. */
  fallback?: ResolvedMember;
  /** connectionId -> time its limit resets. Shared across runs; updated here. */
  limited?: Map<string, number>;
  /** Paths agents must never read or change. */
  isProtected?: (rel: string) => boolean;
  /**
   * A free or cheap model that runs the crew: it assigns every task (so the architect only
   * thinks and plans) and, when `managerPicksTeam` is set (Auto), chooses who plans, builds
   * and reviews. Its calls never fail the run: on any problem the defaults stand.
   */
  manager?: ResolvedMember;
  managerPicksTeam?: boolean;
  /** Your approvals for agent actions (Claude Code style). Absent: nothing asks. */
  approvals?: Approvals;
}

/** An action the user declined: not retried by another agent, not counted as a failure. */
class DeclinedError extends Error {}

/** What the run changed, so it can be undone later. */
export interface Checkpoint {
  files: { path: string; before: string | null; afterHash: string | null }[];
  /** Files that were binary or too large to keep a copy of. */
  skipped: string[];
}

export interface RunResult {
  summary: string;
  changedFiles: string[];
  checkpoint: Checkpoint;
}

export const hashText = (t: string | undefined | null) =>
  t == null ? null : createHash("sha256").update(t).digest("hex");

const isCli = (m: ResolvedMember) => AGENT_KINDS.includes(m.connection.kind);

/** Agent watchdog limits; overridable for slow local models. */
const DEFAULT_LIMITS = {
  idleMs: Number(process.env.MULTICODE_AGENT_IDLE_MS) || 4 * 60_000,
  maxMs: Number(process.env.MULTICODE_AGENT_MAX_MS) || 15 * 60_000,
};

/**
 * Shared machinery for every agent call: watchdog, token usage, and the free fallback
 * that keeps work going when an account runs out of quota.
 */
type KitOptions = Pick<
  RunOptions,
  "emit" | "signal" | "limits" | "limited" | "fallback" | "mcpServers" | "env" | "approvals"
>;

function agentKit(o: KitOptions) {
  const { emit, signal } = o;
  const limits = o.limits ?? DEFAULT_LIMITS;
  const limited = o.limited ?? new Map<string, number>();

  const call = async (
    member: ResolvedMember,
    ws: Workspace,
    title: string,
    system: string,
    prompt: string,
    mode: "text" | "edit",
    /** Collects what the user approved (project files) or declined during this call. */
    track?: { approved: Set<string>; declined: boolean },
  ) => {
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
    const silent = () =>
      stop(
        `${member.name} went silent for ${Math.round(limits.idleMs / 60_000)} min`,
      );
    let idle = setTimeout(silent, limits.idleMs);
    // Time spent waiting for your approval doesn't count against the agent.
    let waitingOnYou = 0;
    const tooLong = () => {
      if (waitingOnYou) hard = setTimeout(tooLong, limits.idleMs);
      else stop(`${member.name} ran past ${Math.round(limits.maxMs / 60_000)} min`);
    };
    let hard = setTimeout(tooLong, limits.maxMs);
    const rel = (f: string) =>
      path.relative(ws.root, path.resolve(ws.root, f)).split(path.sep).join("/");
    const approvals = o.approvals;
    const approve =
      approvals && !(approvals.free("edit") && approvals.free("tool"))
        ? async (a: ApprovalAsk) => {
            const files = a.files?.map(rel);
            let ok: boolean;
            if (approvals.free(a.kind)) ok = true;
            else {
              clearTimeout(idle);
              waitingOnYou++;
              try {
                ok = await approvals.ask(member.id, { ...a, ...(files ? { files } : {}) });
              } finally {
                waitingOnYou--;
                idle = setTimeout(silent, limits.idleMs);
              }
            }
            if (ok) files?.forEach((f) => track?.approved.add(f));
            else if (track) track.declined = true;
            return ok;
          }
        : undefined;
    const free = P.costTier(member) === "free";
    try {
      const text = await member.provider.generate(
        {
          system,
          prompt,
          model: member.model,
          cwd: ws.root,
          mode,
          mcpServers: o.mcpServers,
          env: o.env,
          ...(approve ? { approve } : {}),
          onUsage: (u) =>
            emit({
              type: "usage",
              streamId,
              memberId: member.id,
              input: u.input,
              output: u.output,
              cached: u.cached ?? 0,
              costUsd: free ? 0 : (u.costUsd ?? 0),
              free,
            }),
        },
        (t) => {
          clearTimeout(idle);
          idle = setTimeout(silent, limits.idleMs);
          emit({ type: "agent.delta", streamId, text: t });
        },
        local.signal,
      );
      emit({ type: "agent.end", streamId, ok: true });
      return text;
    } catch (err) {
      const message =
        reason && !signal.aborted
          ? `Stopped: ${reason}.`
          : (err as Error).message;
      emit({ type: "agent.end", streamId, ok: false, error: message });
      throw new Error(message);
    } finally {
      clearTimeout(idle);
      clearTimeout(hard);
      signal.removeEventListener("abort", onRunAbort);
    }
  };

  /** The member to use now: its free stand-in while its account is limited. */
  const pick = (m: ResolvedMember) =>
    o.fallback &&
    m.id !== o.fallback.id &&
    (limited.get(m.connection.id) ?? 0) > Date.now()
      ? o.fallback
      : m;

  /**
   * Runs a step with the member, or with the free fallback if the member's account is out of
   * quota (now or earlier). Work never stops just because one subscription ran dry.
   */
  const withFallback = async <T>(
    member: ResolvedMember,
    step: (m: ResolvedMember) => Promise<T>,
  ): Promise<T> => {
    const first = pick(member);
    try {
      return await step(first);
    } catch (err) {
      const msg = (err as Error).message;
      if (
        !o.fallback ||
        first.id === o.fallback.id ||
        signal.aborted ||
        !isLimitError(msg)
      )
        throw err;
      const until = Date.now() + limitCooldownMs(msg);
      limited.set(member.connection.id, until);
      emit({
        type: "member.limit",
        memberId: member.id,
        until,
        reason: msg.slice(0, 240),
        fallback: o.fallback.name,
      });
      return step(o.fallback);
    }
  };

  return { call, withFallback, pick };
}

/** Plans, builds in parallel, reviews and fixes. */
export async function runCrew(o: RunOptions): Promise<RunResult> {
  const { workspace: ws, emit, signal } = o;
  let roles = o.roles;
  const { call, withFallback } = agentKit(o);
  const isProtected = o.isProtected ?? (() => false);
  const economy = o.settings.economy;
  const changed = new Set<string>();
  let known: FileSnapshot = await ws.snapshot();
  const baseline = await captureBaseline(ws);
  let syncing: Promise<void> = Promise.resolve();

  const checkAbort = () => {
    if (signal.aborted) throw new Error("Cancelled");
  };

  /**
   * Diffs the folder against the last known state and reports changes (serialised).
   * Changes to protected files are rolled back on the spot.
   */
  const syncChanges = (memberId: string) =>
    (syncing = syncing.then(async () => {
      const now = await ws.snapshot();
      const blocked: string[] = [];
      for (const c of Workspace.diff(known, now)) {
        if (isProtected(c.path)) {
          const before = baseline.get(c.path);
          if (before === undefined) await ws.remove(c.path);
          else if (before !== null) await ws.write(c.path, before);
          blocked.push(c.path);
          continue;
        }
        changed.add(c.path);
        emit({
          type: "file.changed",
          path: c.path,
          change: c.change,
          memberId,
        });
      }
      if (blocked.length) emit({ type: "protected", paths: blocked });
      known = blocked.length ? await ws.snapshot() : now;
    }));

  const digest = (maxChars: number, focus: string[] = [], othersMax = Infinity) =>
    ws.contextDigest(maxChars, focus, isProtected, othersMax);

  // A manager call is advice: if it fails or answers nonsense, the run carries on without it.
  const ask = async (
    title: string,
    system: string,
    prompt: string,
  ): Promise<unknown> => {
    if (!o.manager) return undefined;
    try {
      return extractJson(
        await call(o.manager, ws, title, system, prompt, "text"),
      );
    } catch (err) {
      if (signal.aborted) throw err;
      return undefined;
    }
  };

  // A bare greeting or thanks needs no model at all.
  const small = smallTalkReply(o.prompt);
  if (small) return { summary: small, changedFiles: [], checkpoint: { files: [], skipped: [] } };

  // 0. Auto: the manager staffs the request from every connection.
  if (o.manager && o.managerPicksTeam) {
    const pool = [
      ...new Map(
        [roles.architect, roles.reviewer, ...roles.builders].map((m) => [
          m.id,
          m,
        ]),
      ).values(),
    ];
    if (pool.length >= 2) {
      emit({ type: "phase", phase: "planning", round: 0 });
      const pick = (await ask(
        "Choosing the team",
        P.managerTeamSystem(economy),
        P.managerTeamPrompt(o.prompt, pool),
      )) as
        | { architect?: unknown; reviewer?: unknown; builders?: unknown }
        | undefined;
      const byId = (id: unknown) => pool.find((m) => m.id === id);
      const builders = Array.isArray(pick?.builders)
        ? pick.builders.map(byId).filter((m): m is ResolvedMember => Boolean(m))
        : [];
      const architect = byId(pick?.architect);
      if (architect && builders.length)
        roles = {
          architect,
          reviewer: byId(pick?.reviewer) ?? architect,
          builders: [...new Set(builders)],
        };
    }
  }

  // 1. Plan (always: even a single model thinks the work through before it builds)
  emit({ type: "phase", phase: "planning", round: 0 });
  const archCtx = await digest(0);
  const smart = o.settings.dispatch === "smart" && roles.builders.length > 1;
  // With a manager, the architect only thinks; the manager assigns the tasks afterwards.
  const architectDispatches = smart && !o.manager;
  const builderIds = new Set(roles.builders.map((b) => b.id));
  const planText = await withFallback(roles.architect, (m) =>
    call(
      m,
      ws,
      architectDispatches ? "Planning and dispatching" : "Planning the work",
      P.architectSystem(architectDispatches, economy),
      P.architectPrompt(
        o.prompt,
        archCtx.tree,
        o.history,
        architectDispatches ? P.roster(roles.builders) : "",
      ),
      "text",
    ),
  );
  const plan: Plan = parsePlan(planText, o.prompt);
  if (smart && o.manager && plan.tasks.length) {
    const answer = (await ask(
      "Assigning the tasks",
      P.managerDispatchSystem(economy),
      P.managerDispatchPrompt(plan, roles.builders),
    )) as { assignments?: unknown } | undefined;
    for (const a of Array.isArray(answer?.assignments)
      ? answer.assignments
      : []) {
      const { task, assignee, why } = (a ?? {}) as Record<string, unknown>;
      const t = plan.tasks.find((x) => x.id === task);
      if (!t || typeof assignee !== "string") continue;
      t.assignee = assignee;
      if (typeof why === "string" && why) t.why = why.slice(0, 120);
    }
  }
  for (const t of plan.tasks) {
    if (!smart || !t.assignee || !builderIds.has(t.assignee)) {
      delete t.assignee;
      delete t.why;
    }
  }
  // The message asked for nothing to be built: the architect's answer is the reply, and no
  // builder or reviewer runs (a "hello" used to start a whole build).
  if (plan.reply)
    return { summary: plan.reply, changedFiles: [], checkpoint: { files: [], skipped: [] } };
  emit({ type: "plan", plan });
  checkAbort();

  // Read-only safety mode: the plan is the deliverable.
  if (o.settings.safety === "readonly") {
    const steps = plan.tasks
      .map(
        (t, i) =>
          `${i + 1}. ${t.title}${t.files.length ? ` (${t.files.join(", ")})` : ""}`,
      )
      .join("\n");
    return {
      summary: `${plan.summary}\n\n${steps}`.trim(),
      changedFiles: [],
      checkpoint: { files: [], skipped: [] },
    };
  }

  // 2. Build (and later fix) in parallel
  let failures = 0;
  /** Tasks whose change you declined. */
  let declined = 0;
  /** Who last wrote each file: review fixes go back to the agent that knows the file. */
  const owner = new Map<string, string>();
  // Each member contributes as many workers as it has parallel agents.
  const workers = roles.builders.flatMap((m) =>
    Array.from({ length: Math.max(1, Math.min(4, m.agents ?? 1)) }, () => m),
  );
  const buildContext = economy ? 30_000 : 80_000;

  const buildTask = async (
    member: ResolvedMember,
    task: PlanTask,
    basePlan: Plan,
    attempt: number,
  ) => {
    const cli = isCli(member);
    const ctx = cli
      ? { tree: (await digest(0)).tree, files: "" }
      : await digest(buildContext, task.files, economy ? 4_000 : 12_000);
    const track = { approved: new Set<string>(), declined: false };
    // Agents that edit on their own and can't all pause first: remember the folder so a change
    // you didn't approve beforehand can be shown to you after, and reverted if you decline.
    const checkAfter = cli && o.approvals && !o.approvals.free("review");
    const before = checkAfter
      ? { text: await captureBaseline(ws), snap: await ws.snapshot() }
      : undefined;
    inFlight.set(task.id, new Set(task.files));
    try {
    const reply = await call(
      member,
      ws,
      attempt ? `${task.title} (retry)` : task.title,
      P.builderSystem(cli, member.instructions) +
        (cli || !o.skillText ? "" : `\n\nSkills to apply:${o.skillText}`),
      P.builderPrompt({
        request: o.prompt,
        plan: basePlan,
        task,
        tree: ctx.tree,
        files: ctx.files,
      }),
      "edit",
      track,
    );
    if (track.declined)
      throw new DeclinedError(`You declined ${member.name}'s change.`);
    if (!cli) {
      const ops = parseFileOps(reply).filter((op) => !isProtected(op.path));
      if (!ops.length) throw new Error("Builder returned no file changes.");
      if (o.approvals && !o.approvals.free("edit")) {
        const ok = await o.approvals.ask(member.id, {
          kind: "edit",
          title: `${member.name} · ${task.title}`,
          files: ops.map((op) => op.path),
          detail: await previewOps(ops),
        });
        if (!ok) throw new DeclinedError(`You declined ${member.name}'s change.`);
      }
      for (const op of ops) {
        if (op.change === "write") await ws.write(op.path, op.content ?? "");
        else await ws.remove(op.path);
      }
    } else if (before) await checkChanges(member, task, before, track.approved);
    } finally {
      inFlight.delete(task.id);
    }
  };

  /** Tasks building right now and the files each owns (parallel tasks never review each other's). */
  const inFlight = new Map<string, Set<string>>();

  const previewOps = async (ops: ReturnType<typeof parseFileOps>) => {
    let out = "";
    for (const op of ops) {
      if (out.length > 20_000) break;
      const prev = await ws.tryRead(op.path);
      out +=
        op.change === "write"
          ? patchOf(op.path, op.path, prev ?? "", op.content ?? "", prev === undefined ? "(new)" : "", "", { context: 2 })
          : `--- ${op.path} (delete)\n`;
    }
    return out;
  };

  /**
   * After an agent that edits on its own: shows you what it changed that you hadn't approved
   * beforehand. Declining puts every one of those files back as it was before the task.
   */
  const checkChanges = async (
    member: ResolvedMember,
    task: PlanTask,
    before: { text: Map<string, string | null>; snap: FileSnapshot },
    approved: Set<string>,
  ) => {
    const now = await ws.snapshot();
    const others = [...inFlight].filter(([id]) => id !== task.id).flatMap(([, f]) => [...f]);
    const files = [...new Set([...Object.keys(before.snap), ...Object.keys(now)])].filter(
      (f) =>
        before.snap[f] !== now[f] &&
        !approved.has(f) &&
        !isProtected(f) &&
        !others.includes(f),
    );
    if (!files.length) return;
    let detail = "";
    for (const f of files) {
      if (detail.length > 20_000) break;
      const prev = before.text.get(f);
      const cur = await ws.tryRead(f);
      detail +=
        prev === null || (cur !== undefined && cur.includes("\0"))
          ? `--- ${f} (binary or large file changed)\n`
          : patchOf(f, f, prev ?? "", cur ?? "", prev === undefined ? "(new)" : "", cur === undefined ? "(deleted)" : "", { context: 2 });
    }
    const ok = await o.approvals!.ask(member.id, {
      kind: "review",
      title: `${member.name} changed ${files.length} file${files.length === 1 ? "" : "s"} · ${task.title}`,
      files,
      detail,
    });
    if (ok) return;
    const kept: string[] = [];
    for (const f of files) {
      const prev = before.text.get(f);
      if (prev === undefined) await ws.remove(f).catch(() => {});
      else if (prev === null) kept.push(f);
      else await ws.write(f, prev);
    }
    // Reverted files are back as they were: don't report them as changed later.
    const after = await ws.snapshot();
    for (const f of files) {
      if (kept.includes(f)) continue;
      if (after[f] === undefined) delete known[f];
      else known[f] = after[f]!;
    }
    throw new DeclinedError(
      `You declined ${member.name}'s change; it was reverted${kept.length ? ` (except ${kept.join(", ")}, too large to restore)` : ""}.`,
    );
  };

  const build = async (
    tasks: PlanTask[],
    basePlan: Plan,
    attempt = 0,
  ): Promise<void> => {
    if (attempt === 0) failures = 0;
    const failed: { task: PlanTask; by: string }[] = [];
    tasks.forEach((t) =>
      emit({
        type: "task.status",
        taskId: t.id,
        status: "queued",
        memberId: t.assignee,
      }),
    );
    await scheduleTasks(
      tasks,
      workers,
      async (task, member) => {
        if (signal.aborted) return;
        emit({
          type: "task.status",
          taskId: task.id,
          status: "running",
          memberId: member.id,
        });
        // Fingerprint the files this task owns, to verify the agent really wrote them.
        const before = new Map<string, string | null>();
        for (const f of task.files)
          before.set(f, hashText(await ws.tryRead(f)));
        try {
          await withFallback(member, (m) =>
            buildTask(m, task, basePlan, attempt),
          );
          await syncChanges(member.id);
          const owned = task.files.filter((f) => !isProtected(f));
          if (owned.length) {
            let touched = false;
            for (const f of owned)
              if (hashText(await ws.tryRead(f)) !== before.get(f))
                touched = true;
            if (!touched)
              throw new Error(
                `${member.name} finished without writing ${owned.join(", ")}.`,
              );
          }
          task.files.forEach((f) => owner.set(f, member.id));
          emit({
            type: "task.status",
            taskId: task.id,
            status: "done",
            memberId: member.id,
          });
        } catch (err) {
          await syncChanges(member.id);
          if (signal.aborted) return;
          if (err instanceof DeclinedError) {
            declined++;
            emit({
              type: "task.status",
              taskId: task.id,
              status: "failed",
              memberId: member.id,
              error: err.message,
            });
            return;
          }
          failed.push({ task, by: member.id });
          emit({
            type: "task.status",
            taskId: task.id,
            status: "failed",
            memberId: member.id,
            error: (err as Error).message,
          });
        }
      },
      (task, member) => !task.assignee || task.assignee === member.id,
    );
    checkAbort();

    // One more chance for each failed task, preferably with a different agent.
    if (failed.length && attempt === 0) {
      const retries = failed.map(({ task, by }, i) => {
        const others = roles.builders.filter((b) => b.id !== by);
        const next = others.length
          ? others[i % others.length]!
          : roles.builders.find((b) => b.id === by)!;
        const name =
          roles.builders.find((b) => b.id === by)?.name ?? "The agent";
        return {
          ...task,
          id: `${task.id}-retry`,
          assignee: next.id,
          why:
            next.id === by
              ? "Retrying after a failed attempt"
              : `Reassigned: ${name} didn't finish`,
        };
      });
      emit({ type: "tasks.added", tasks: retries, round: 0 });
      await build(retries, basePlan, 1);
      return;
    }
    failures += failed.length;
  };

  emit({ type: "phase", phase: "building", round: 0 });
  await build(plan.tasks, plan);
  await syncing;
  if (declined && !changed.size)
    return {
      summary: "You declined the crew's changes, so nothing in the project was changed.",
      changedFiles: [],
      checkpoint: { files: [], skipped: [] },
    };
  if (failures >= plan.tasks.length)
    throw new Error("Every build task failed — check the agent errors above.");
  if (!changed.size)
    throw new Error(
      "The builders finished without changing any files in the project.",
    );

  // 3. Review loop (Economy: one round, by the cheapest member)
  const rounds = economy
    ? Math.min(1, o.settings.maxReviewRounds)
    : o.settings.maxReviewRounds;
  // Economy: one cheap reviewer. Otherwise every reviewer (e.g. code + security) checks in parallel.
  const reviewers = economy
    ? [cheapest([roles.reviewer, roles.architect, ...roles.builders])]
    : roles.reviewers?.length
      ? roles.reviewers
      : [roles.reviewer];
  let reviewSummary = "";
  for (let round = 1; round <= rounds; round++) {
    emit({ type: "phase", phase: "reviewing", round });
    const verdicts = await Promise.all(
      reviewers.map(async (reviewer) => {
        const text = await withFallback(reviewer, async (m) => {
          const ctx = isCli(m)
            ? {
                tree: (await digest(0)).tree,
                files: `What changed (diff):\n${diffText(await diffChanges(ws, baseline, [...changed]))}\n\nReview this change. Open a file from the current directory only when the diff is not enough to judge it.`,
              }
            : await digest(economy ? 40_000 : 80_000, [...changed], economy ? 4_000 : 10_000);
          const what = reviewer.instructions
            ? reviewer.instructions.split(/[:.]/)[0]!.trim()
            : "";
          return call(
            m,
            ws,
            `${round === 1 ? "Reviewing the build" : `Re-review (round ${round})`}${reviewers.length > 1 && what ? ` · ${what}` : ""}`,
            P.reviewerSystem(reviewer.instructions),
            P.reviewerPrompt(o.prompt, plan, ctx.tree, ctx.files),
            "text",
          );
        }).catch((err: Error) => {
          // A failing reviewer should not throw away finished work.
          checkAbort();
          return JSON.stringify({
            approved: true,
            summary: `Review skipped: ${err.message}`,
            issues: [],
          });
        });
        return { reviewer, review: parseReview(text) };
      }),
    );
    // One verdict: approved only if every reviewer approves; issues from all of them.
    const seen = new Set<string>();
    const review = {
      approved: verdicts.every((v) => v.review.approved),
      summary:
        verdicts.length === 1
          ? verdicts[0]!.review.summary
          : verdicts
              .map((v) => `${v.reviewer.name}: ${v.review.summary}`)
              .join("\n"),
      issues: verdicts
        .flatMap((v) => v.review.issues)
        .filter((i) => {
          const key = `${i.file}|${i.problem}`;
          return seen.has(key) ? false : (seen.add(key), true);
        }),
    };
    reviewSummary = review.summary;
    emit({ type: "review", review, round });
    checkAbort();
    if (review.approved || !review.issues.length) break;

    emit({ type: "phase", phase: "fixing", round });
    const fixes = P.fixTasks(review.issues, round).map((t) => {
      const who = t.files.map((f) => owner.get(f)).find(Boolean);
      return who && builderIds.has(who)
        ? { ...t, assignee: who, why: "Wrote this file" }
        : t;
    });
    emit({ type: "tasks.added", tasks: fixes, round });
    await build(fixes, { summary: plan.summary, tasks: fixes });
    // The last review's fixes are concrete instructions: they are applied without paying for
    // another full review session.
    if (round === rounds) break;
  }

  await syncing;
  const changedFiles = [...changed].sort();
  emit({
    type: "run.diff",
    files: await diffChanges(ws, baseline, changedFiles),
  });
  const summary = [plan.summary, reviewSummary].filter(Boolean).join("\n\n");

  const checkpoint: Checkpoint = { files: [], skipped: [] };
  for (const path of changedFiles) {
    const before = baseline.get(path);
    if (before === null) {
      checkpoint.skipped.push(path);
      continue;
    }
    checkpoint.files.push({
      path,
      before: before ?? null,
      afterHash: hashText(await ws.tryRead(path)),
    });
  }
  return { summary: summary || "Done.", changedFiles, checkpoint };
}

/** A compact unified diff for a reviewer, capped so a huge change can't flood the prompt. */
function diffText(files: FileDiff[], max = 40_000): string {
  let out = "";
  for (const f of files) {
    const body = f.skipped
      ? "(binary or too large to show)"
      : f.hunks.map((h) => [h.header, ...h.lines].join("\n")).join("\n");
    out += `--- ${f.path} (${f.change})\n${body}\n`;
    if (out.length > max) return out.slice(0, max) + "\n…(diff truncated)";
  }
  return out || "(no changes)";
}

/** The member that costs least to run: free, then flat-rate subscription, then pay-per-token. */
const SMALL_TALK =
  /^\s*(hi|hiya|hello|hey|yo|sup|thanks|thank you|thx|ty|ok|okay|cool|nice|great|good morning|good evening|שלום|היי|הי|אהלן|תודה|תודה רבה|בוקר טוב|ערב טוב|אוקיי|סבבה|יופי|מעולה)\s*[!.?,:)]*\s*$/i;

/** An answer for a message that is only a greeting or thanks, so no model is called for it. */
export function smallTalkReply(prompt: string): string | undefined {
  if (!SMALL_TALK.test(prompt)) return undefined;
  const hebrew = /[\u0590-\u05FF]/.test(prompt);
  const thanks = /thank|thx|\bty\b|תודה/i.test(prompt);
  if (thanks)
    return hebrew
      ? "בשמחה! מה נבנה הלאה?"
      : "You're welcome! What should we build next?";
  return hebrew
    ? "היי! תאר מה לבנות או לשנות בפרויקט, והצוות יתכנן, יבנה ויבדוק את זה."
    : "Hi! Describe what to build or change in this project, and the crew will plan, build and review it.";
}

export function cheapest(members: ResolvedMember[]): ResolvedMember {
  const rank = (m: ResolvedMember) =>
    ({ free: 0, "subscription (flat rate)": 1 })[P.costTier(m)] ?? 2;
  return [...members].sort((a, b) => rank(a) - rank(b))[0]!;
}

/** Visual directions handed out so variants differ meaningfully. */
export const DESIGN_DIRECTIONS = [
  {
    title: "Calm minimal",
    direction:
      "Airy and minimal: generous whitespace, one restrained accent, refined typography, subtle motion.",
  },
  {
    title: "Bold expressive",
    direction:
      "Bold and expressive: strong colour, oversized display type, confident shapes, energetic layout.",
  },
  {
    title: "Warm editorial",
    direction:
      "Warm and editorial: serif headings, soft natural palette, magazine-like rhythm and imagery blocks.",
  },
  {
    title: "Dark technical",
    direction:
      "Dark and technical: dense information, monospace accents, crisp grid, neon-free high contrast.",
  },
];

export interface DesignOptions extends Omit<RunOptions, "workspace"> {
  /** One sandbox workspace per variant. */
  variants: {
    variant: DesignVariant;
    member: ResolvedMember;
    workspace: Workspace;
  }[];
}

/**
 * MultiDesign: several models each design their own take on the request, in separate
 * sandboxes and at the same time. You compare the live previews and apply the one you like.
 */
export async function runDesign(
  o: DesignOptions,
): Promise<{ summary: string; done: string[] }> {
  const { call, withFallback } = agentKit(o);
  const { emit, signal } = o;
  emit({ type: "variants", variants: o.variants.map((v) => v.variant) });
  emit({ type: "phase", phase: "building", round: 0 });
  const done: string[] = [];
  await Promise.all(
    o.variants.map(async ({ variant, member, workspace }) => {
      emit({
        type: "task.status",
        taskId: variant.id,
        status: "running",
        memberId: member.id,
      });
      try {
        const before = await workspace.snapshot();
        await withFallback(member, async (m) => {
          const cli = isCli(m);
          const ctx = cli
            ? { tree: (await workspace.contextDigest(0)).tree, files: "" }
            : await workspace.contextDigest(60_000, [], o.isProtected);
          const reply = await call(
            m,
            workspace,
            `Design: ${variant.title}`,
            P.designerSystem(cli, m.instructions) +
              (cli || !o.skillText ? "" : `\n\nSkills to apply:${o.skillText}`),
            P.designerPrompt(o.prompt, variant.direction, ctx.tree, ctx.files),
            "edit",
          );
          if (!cli) {
            const ops = parseFileOps(reply).filter(
              (op) => !o.isProtected?.(op.path),
            );
            if (!ops.length) throw new Error("The designer returned no files.");
            for (const op of ops) {
              if (op.change === "write")
                await workspace.write(op.path, op.content ?? "");
              else await workspace.remove(op.path);
            }
          }
        });
        if (!Workspace.diff(before, await workspace.snapshot()).length)
          throw new Error(`${member.name} didn't produce a design.`);
        done.push(variant.id);
        emit({
          type: "task.status",
          taskId: variant.id,
          status: "done",
          memberId: member.id,
        });
      } catch (err) {
        if (signal.aborted) return;
        emit({
          type: "task.status",
          taskId: variant.id,
          status: "failed",
          memberId: member.id,
          error: (err as Error).message,
        });
      }
    }),
  );
  if (signal.aborted) throw new Error("Cancelled");
  if (!done.length)
    throw new Error(
      "No design variant was produced — check the agent errors above.",
    );
  return {
    summary: `${done.length} design${done.length === 1 ? "" : "s"} ready. Pick the one you like to apply it.`,
    done,
  };
}
