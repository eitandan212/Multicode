// Types shared by the server and the web UI. Keep this file dependency-free.

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openai-compatible"
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli"
  | "opencode-cli"
  | "qwen-cli";

export const API_KINDS: ProviderKind[] = ["anthropic", "openai", "gemini", "openai-compatible"];
export const SUBSCRIPTION_KINDS: ProviderKind[] = ["claude-cli", "codex-cli", "gemini-cli"];
export const OPEN_SOURCE_KINDS: ProviderKind[] = ["opencode-cli", "qwen-cli"];
export const CLI_KINDS: ProviderKind[] = [...SUBSCRIPTION_KINDS, ...OPEN_SOURCE_KINDS];

export const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  gemini: "Google Gemini API",
  "openai-compatible": "OpenAI-compatible API",
  "claude-cli": "Claude subscription (Claude Code)",
  "codex-cli": "ChatGPT subscription (Codex CLI)",
  "gemini-cli": "Google subscription (Gemini CLI)",
  "opencode-cli": "OpenCode (75+ providers, free models)",
  "qwen-cli": "Qwen Code (free Qwen account)",
};

/** A connection as seen by the UI: secrets are never sent, only whether one is set. */
export interface ConnectionView {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  defaultModel?: string;
  hasKey: boolean;
  keyHint?: string;
}

export type Role = "architect" | "builder" | "reviewer";

export interface CrewMember {
  id: string;
  name: string;
  role: Role;
  connectionId: string;
  model?: string;
  /** How many parallel agents this member runs (builders only). 1-4. */
  agents?: number;
  /** The member's specialty or standing instructions; also used by the dispatcher. */
  instructions?: string;
}

export type DispatchMode = "smart" | "balanced";

export interface Settings {
  maxReviewRounds: number;
  /** smart: the dispatcher assigns each task to the best-fitting agent. balanced: first free agent. */
  dispatch: DispatchMode;
}

/** An MCP server shared with every harness that supports MCP. */
export interface McpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Names of environment variables the server needs. Values live in MultiCode's private config. */
  envNames?: string[];
}

export interface SyncConfigView {
  instructions: string;
  mcpServers: McpServer[];
  /** Env var names that have a stored value (values are never sent to the UI). */
  envSet: string[];
}

export interface HarnessSyncStatus {
  harness: string;
  files: string[];
  note?: string;
}

export interface ProjectInfo {
  name: string;
  fileCount: number;
  updatedAt: number;
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  /** Crew member the dispatcher picked for this task. */
  assignee?: string;
  /** One-line reason for the pick. */
  why?: string;
}

export interface Plan {
  summary: string;
  tasks: PlanTask[];
}

export interface ReviewIssue {
  file: string;
  problem: string;
  fix: string;
}

export interface Review {
  approved: boolean;
  summary: string;
  issues: ReviewIssue[];
}

export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface FileDiff {
  path: string;
  change: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when the file was too large or binary to diff. */
  skipped?: boolean;
}

export type TaskStatus = "queued" | "running" | "done" | "failed";

export type RunEvent =
  | { type: "run.started"; runId: string; project: string; prompt: string; at: number }
  | { type: "phase"; phase: "planning" | "building" | "reviewing" | "fixing"; round: number }
  | { type: "plan"; plan: Plan }
  | { type: "tasks.added"; tasks: PlanTask[]; round: number }
  | { type: "task.status"; taskId: string; status: TaskStatus; memberId?: string; error?: string }
  | { type: "agent.start"; streamId: string; memberId: string; title: string }
  | { type: "agent.delta"; streamId: string; text: string }
  | { type: "agent.end"; streamId: string; ok: boolean; error?: string }
  | { type: "file.changed"; path: string; change: "write" | "delete"; memberId: string }
  | { type: "review"; review: Review; round: number }
  | { type: "run.diff"; files: FileDiff[] }
  | { type: "run.done"; summary: string; changedFiles: string[]; at: number }
  | { type: "run.error"; error: string; at: number };

export interface RunSummary {
  id: string;
  project: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  /** Set when the run's file changes have been undone. */
  undoneAt?: number;
  /** True when a checkpoint exists, so the run can be undone. */
  canUndo?: boolean;
}
