import type { FileDiff, Plan, Review, RunEvent, TaskStatus } from "../../server/shared";

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
  changed: string[];
  status: "running" | "done" | "error";
  summary?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  diff?: FileDiff[];
}

const MAX_STREAM_CHARS = 200_000;

export function emptyRun(id: string, prompt = ""): RunView {
  return { id, prompt, phase: "starting", tasks: [], streams: [], reviews: [], changed: [], status: "running" };
}

export function reduceRun(s: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "run.started":
      return { ...s, prompt: e.prompt, startedAt: e.at };
    case "phase":
      return { ...s, phase: e.phase };
    case "plan":
      return {
        ...s,
        plan: e.plan,
        tasks: e.plan.tasks.map((t): TaskState => ({ id: t.id, title: t.title, files: t.files, status: "queued", memberId: t.assignee, why: t.why })),
      };
    case "tasks.added":
      return {
        ...s,
        tasks: [
          ...s.tasks,
          ...e.tasks.map((t): TaskState => ({ id: t.id, title: t.title, files: t.files, status: "queued", fix: true, memberId: t.assignee, why: t.why })),
        ],
      };
    case "task.status":
      return {
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === e.taskId ? { ...t, status: e.status, memberId: e.memberId ?? t.memberId, error: e.error } : t,
        ),
      };
    case "agent.start":
      return { ...s, streams: [...s.streams, { id: e.streamId, memberId: e.memberId, title: e.title, text: "", status: "live" }] };
    case "agent.delta":
      return {
        ...s,
        streams: s.streams.map((st) =>
          st.id === e.streamId && st.text.length < MAX_STREAM_CHARS ? { ...st, text: st.text + e.text } : st,
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
      return s.changed.includes(e.path) ? s : { ...s, changed: [...s.changed, e.path] };
    case "review":
      return { ...s, reviews: [...s.reviews, { round: e.round, review: e.review }] };
    case "run.diff":
      return { ...s, diff: e.files };
    case "run.done":
      return { ...s, status: "done", phase: "done", summary: e.summary, endedAt: e.at };
    case "run.error":
      return { ...s, status: "error", phase: "stopped", error: e.error, endedAt: e.at };
  }
}
