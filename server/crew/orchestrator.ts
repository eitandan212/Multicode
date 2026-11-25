import { createHash, randomUUID } from "node:crypto";
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
  type McpServer,
  type Plan,
  type PlanTask,
  type RunEvent,
  type Settings,
} from "../shared.js";
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
  if (!members.length)
    throw new Error("Connect at least one AI account and add it to your crew.");
  const by = (r: CrewMember["role"]) => members.filter((m) => m.role === r);
  const builders = by("builder").length ? by("builder") : members;
  const architect = by("architect")[0] ?? by("reviewer")[0] ?? builders[0]!;
  const reviewer =
    by("reviewer")[0] ?? by("architect")[0] ?? builders[builders.length - 1]!;
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
}

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
  "emit" | "signal" | "limits" | "limited" | "fallback" | "mcpServers" | "env"
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
    const hard = setTimeout(
      () =>
        stop(
          `${member.name} ran past ${Math.round(limits.maxMs / 60_000)} min`,
        ),
      limits.maxMs,
    );
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
          onUsage: (u) =>
            emit({
              type: "usage",
              streamId,
              memberId: member.id,
              input: u.input,
              output: u.output,
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
  const { workspace: ws, roles, emit, signal } = o;
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

  const digest = (maxChars: number, focus: string[] = []) =>
    ws.contextDigest(maxChars, focus, isProtected);

  // 1. Plan (always: even a single model thinks the work through before it builds)
  emit({ type: "phase", phase: "planning", round: 0 });
  const archCtx = await digest(0);
  const smart = o.settings.dispatch === "smart" && roles.builders.length > 1;
  const builderIds = new Set(roles.builders.map((b) => b.id));
  const planText = await withFallback(roles.architect, (m) =>
    call(
      m,
      ws,
      smart ? "Planning and dispatching" : "Planning the work",
      P.architectSystem(smart, economy),
      P.architectPrompt(
        o.prompt,
        archCtx.tree,
        o.history,
        smart ? P.roster(roles.builders) : "",
      ),
      "text",
    ),
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
      : await digest(buildContext, task.files);
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
    );
    if (!cli) {
      const ops = parseFileOps(reply).filter((op) => !isProtected(op.path));
      if (!ops.length) throw new Error("Builder returned no file changes.");
      for (const op of ops) {
        if (op.change === "write") await ws.write(op.path, op.content ?? "");
        else await ws.remove(op.path);
      }
    }
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
  if (failures >= plan.tasks.length)
    throw new Error("Every build task failed — check the agent errors above.");
  await syncing;
  if (!changed.size)
    throw new Error(
      "The builders finished without changing any files in the project.",
    );

  // 3. Review loop (Economy: one round, by the cheapest member)
  const rounds = economy
    ? Math.min(1, o.settings.maxReviewRounds)
    : o.settings.maxReviewRounds;
  const reviewer = economy
    ? cheapest([roles.reviewer, roles.architect, ...roles.builders])
    : roles.reviewer;
  let reviewSummary = "";
  for (let round = 1; round <= rounds; round++) {
    emit({ type: "phase", phase: "reviewing", round });
    const reviewText = await withFallback(reviewer, async (m) => {
      const ctx = isCli(m)
        ? {
            tree: (await digest(0)).tree,
            files: "(read the files from the current directory)",
          }
        : await digest(economy ? 50_000 : 120_000, [...changed]);
      return call(
        m,
        ws,
        round === 1 ? "Reviewing the build" : `Re-review (round ${round})`,
        P.reviewerSystem(),
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
    const review = parseReview(reviewText);
    reviewSummary = review.summary;
    emit({ type: "review", review, round });
    checkAbort();
    if (review.approved || round === rounds) break;

    emit({ type: "phase", phase: "fixing", round });
    const fixes = P.fixTasks(review.issues, round).map((t) => {
      const who = t.files.map((f) => owner.get(f)).find(Boolean);
      return who && builderIds.has(who)
        ? { ...t, assignee: who, why: "Wrote this file" }
        : t;
    });
    emit({ type: "tasks.added", tasks: fixes, round });
    await build(fixes, { summary: plan.summary, tasks: fixes });
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

/** The member that costs least to run: free, then flat-rate subscription, then pay-per-token. */
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
