import type {
  DesignVariant,
  FileDiff,
  Plan,
  Review,
  RunEvent,
  SafetyMode,
  TaskStatus,
} from "../../server/shared";

export interface StreamState {
  id: string;
  memberId: string;
  title: string;
  text: string;
  status: "live" | "ok" | "error";
  error?: string;
}

export interface TaskState {
  id: string;
  title: string;
  files: string[];
  status: TaskStatus;
  memberId?: string;
  error?: string;
  fix?: boolean;
  /** Why the dispatcher picked this agent. */
  why?: string;
}

export interface RunView {
  id: string;
  prompt: string;
  phase: string;
  plan?: Plan;
  tasks: TaskState[];
  streams: StreamState[];
  reviews: { round: number; review: Review }[];
  /** Results of the project's check command (e.g. npm test). */
  checks: { round: number; command: string; ok: boolean; output: string; ms: number }[];
  /** Hooks that failed (your commands on events). */
  hookFailures: { event: string; command: string; output: string }[];
  changed: string[];
  status: "running" | "done" | "error";
  summary?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  diff?: FileDiff[];
  /** Skills and plugins active for this thread. */
  context?: {
    skills: string[];
    plugins: string[];
    fallback?: { id: string; name: string };
    manager?: {
      id: string;
      name: string;
      connectionId?: string;
      model?: string;
    };
    safety?: SafetyMode;
    economy?: boolean;
  };
  usage: { input: number; output: number; cached: number; costUsd: number; freeTokens: number };
  limits: {
    memberId: string;
    until: number;
    reason: string;
    fallback: string;
  }[];
  protectedHits: string[];
  variants?: DesignVariant[];
  approval?: "sandbox" | "design";
  /** Agent actions waiting for your yes, oldest first. */
  asks: AskView[];
  /** What you answered, for the history of the thread. */
  answered: { title: string; memberId: string; allow: boolean }[];
}

export type AskView = Extract<RunEvent, { type: "approval.request" }>;

const MAX_STREAM_CHARS = 200_000;

export function emptyRun(id: string, prompt = ""): RunView {
  return {
    id,
    prompt,
    phase: "starting",
    tasks: [],
    streams: [],
    reviews: [],
    checks: [],
    hookFailures: [],
    changed: [],
    status: "running",
    usage: { input: 0, output: 0, cached: 0, costUsd: 0, freeTokens: 0 },
    limits: [],
    protectedHits: [],
    asks: [],
    answered: [],
  };
}

export function reduceRun(s: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "run.started":
      return { ...s, prompt: e.prompt, startedAt: e.at };
    case "approval.request":
      return { ...s, asks: [...s.asks, e] };
    case "approval.resolved": {
      const ask = s.asks.find((a) => a.id === e.id);
      return {
        ...s,
        asks: s.asks.filter((a) => a.id !== e.id),
        answered: ask
          ? [...s.answered, { title: ask.title, memberId: ask.memberId, allow: e.allow }]
          : s.answered,
      };
    }
    case "context":
      return {
        ...s,
        context: {
          skills: e.skills,
          plugins: e.plugins,
          fallback: e.fallback,
          manager: e.manager,
          safety: e.safety,
          economy: e.economy,
        },
      };
    case "usage":
      return {
        ...s,
        usage: {
          input: s.usage.input + e.input,
          output: s.usage.output + e.output,
          cached: s.usage.cached + (e.cached ?? 0),
          costUsd: s.usage.costUsd + e.costUsd,
          freeTokens: s.usage.freeTokens + (e.free ? e.input + e.output : 0),
        },
      };
    case "member.limit":
      return {
        ...s,
        limits: [
          ...s.limits,
          {
            memberId: e.memberId,
            until: e.until,
            reason: e.reason,
            fallback: e.fallback,
          },
        ],
      };
    case "protected":
      return {
        ...s,
        protectedHits: [...new Set([...s.protectedHits, ...e.paths])],
      };
    case "variants":
      return {
        ...s,
        variants: e.variants,
        tasks: e.variants.map(
          (v): TaskState => ({
            id: v.id,
            title: v.title,
            files: [],
            status: "queued",
            memberId: v.memberId,
            why: v.direction,
          }),
        ),
      };
    case "approval":
      return { ...s, approval: e.kind };
    case "phase":
      return { ...s, phase: e.phase };
    case "plan":
      return {
        ...s,
        plan: e.plan,
        tasks: e.plan.tasks.map(
          (t): TaskState => ({
            id: t.id,
            title: t.title,
            files: t.files,
            status: "queued",
            memberId: t.assignee,
            why: t.why,
          }),
        ),
      };
    case "tasks.added":
      return {
        ...s,
        tasks: [
          ...s.tasks,
          ...e.tasks.map(
            (t): TaskState => ({
              id: t.id,
              title: t.title,
              files: t.files,
              status: "queued",
              fix: true,
              memberId: t.assignee,
              why: t.why,
            }),
          ),
        ],
      };
    case "task.status":
      return {
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === e.taskId
            ? {
                ...t,
                status: e.status,
                memberId: e.memberId ?? t.memberId,
                error: e.error,
              }
            : t,
        ),
      };
    case "agent.start":
      return {
        ...s,
        streams: [
          ...s.streams,
          {
            id: e.streamId,
            memberId: e.memberId,
            title: e.title,
            text: "",
            status: "live",
          },
        ],
      };
    case "agent.delta":
      return {
        ...s,
        streams: s.streams.map((st) =>
          st.id === e.streamId && st.text.length < MAX_STREAM_CHARS
            ? { ...st, text: st.text + e.text }
            : st,
        ),
      };
    case "agent.end":
      return {
        ...s,
        streams: s.streams.map((st) => {
          if (st.id !== e.streamId) return st;
          return { ...st, status: e.ok ? "ok" : "error", error: e.error };
        }),
      };
    case "file.changed":
      return s.changed.includes(e.path)
        ? s
        : { ...s, changed: [...s.changed, e.path] };
    case "review":
      return {
        ...s,
        reviews: [...s.reviews, { round: e.round, review: e.review }],
      };
    case "hook":
      return { ...s, hookFailures: [...s.hookFailures, { event: e.event, command: e.command, output: e.output }] };
    case "check":
      return { ...s, checks: [...s.checks, { round: e.round, command: e.command, ok: e.ok, output: e.output, ms: e.ms }] };
    case "run.diff":
      return { ...s, diff: e.files };
    case "run.done":
      return {
        ...s,
        status: "done",
        phase: "done",
        summary: e.summary,
        endedAt: e.at,
      };
    case "run.error":
      return {
        ...s,
        status: "error",
        phase: "stopped",
        error: e.error,
        endedAt: e.at,
      };
  }
}
