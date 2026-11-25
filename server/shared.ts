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
  | "qwen-cli"
  /** Any agent that speaks the Agent Client Protocol (from the ACP registry or a custom command). */
  | "acp";

export const API_KINDS: ProviderKind[] = ["anthropic", "openai", "gemini", "openai-compatible"];
export const SUBSCRIPTION_KINDS: ProviderKind[] = ["claude-cli", "codex-cli", "gemini-cli"];
export const OPEN_SOURCE_KINDS: ProviderKind[] = ["opencode-cli", "qwen-cli"];
export const CLI_KINDS: ProviderKind[] = [...SUBSCRIPTION_KINDS, ...OPEN_SOURCE_KINDS];
/** Kinds whose agent works in the project folder and edits files itself. */
export const AGENT_KINDS: ProviderKind[] = [...CLI_KINDS, "acp"];

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
  acp: "Any ACP agent (Agent Client Protocol)",
};

/** The name people know each harness or service by, shown with its logo. */
export const HARNESS_NAMES: Record<ProviderKind, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "gemini-cli": "Gemini CLI",
  "opencode-cli": "OpenCode",
  "qwen-cli": "Qwen Code",
  acp: "ACP agent",
  anthropic: "Claude API",
  openai: "OpenAI API",
  gemini: "Gemini API",
  "openai-compatible": "OpenAI-compatible",
};

const ENDPOINT_BRANDS: [RegExp, string][] = [
  [/openrouter/i, "OpenRouter"],
  [/groq/i, "Groq"],
  [/deepseek/i, "DeepSeek"],
  [/mistral/i, "Mistral"],
  [/together/i, "Together AI"],
  [/:11434|ollama/i, "Ollama"],
  [/:1234|lmstudio/i, "LM Studio"],
];

const BRANDS: Record<string, string> = {
  gpt: "GPT",
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  gemma: "Gemma",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  llama: "Llama",
  glm: "GLM",
  grok: "Grok",
  kimi: "Kimi",
  mistral: "Mistral",
  codestral: "Codestral",
  phi: "Phi",
  nemotron: "Nemotron",
};

/**
 * A model id as people say it: "claude-opus-5-5" → "Claude Opus 5.5", "gpt-5" → "GPT-5",
 * "deepseek-v4.1-flash-free" → "DeepSeek V4.1 Flash", "openrouter/auto" → "Auto Router".
 */
export function modelDisplayName(model: string): string {
  const id = model.trim().split("/").pop()!.replace(/:free$|-free$/i, "");
  if (!id) return model;
  if (/^auto$/i.test(id)) return "Auto Router";
  const out: string[] = [];
  for (const raw of id.split(/[-_\s]+/).filter(Boolean)) {
    const t = raw.toLowerCase();
    const prev = out[out.length - 1];
    if (/^\d+$/.test(t) && prev && /^\d+(\.\d+)?$/.test(prev) && !prev.includes(".") && t.length <= 2) {
      out[out.length - 1] = `${prev}.${t}`; // "5", "5" → "5.5"
    } else if (/^\d+(\.\d+)?$/.test(t) && prev === "GPT") {
      out[out.length - 1] = `GPT-${t}`;
    } else if (BRANDS[t]) out.push(BRANDS[t]);
    else if (/^v\d/.test(t)) out.push(t.toUpperCase());
    else if (/^\d+(\.\d+)?[bkm]$/.test(t)) out.push(t.toUpperCase());
    else if (/^o\d/.test(t)) out.push(t); // OpenAI o-series stays lowercase
    else out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out.join(" ");
}

const isFreeModel = (model?: string) => Boolean(model && /(-free|:free|big-pickle)$/i.test(model));

/** The service behind a connection: the harness, or the brand of an OpenAI-compatible endpoint. */
export function serviceName(kind: ProviderKind, baseUrl?: string): string {
  if (kind !== "openai-compatible") return HARNESS_NAMES[kind];
  const brand = ENDPOINT_BRANDS.find(([re]) => re.test(baseUrl ?? ""))?.[1];
  if (brand) return brand;
  try {
    const host = baseUrl ? new URL(baseUrl).hostname : "";
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return "Local server";
    return host || HARNESS_NAMES[kind];
  } catch {
    return HARNESS_NAMES[kind];
  }
}

/** Default name for a connection or agent: its model, or the harness when no model is set. */
export function connectionName(kind: ProviderKind, baseUrl?: string, model?: string): string {
  if (model) return `${modelDisplayName(model)}${isFreeModel(model) ? " (free)" : ""}`;
  return serviceName(kind, baseUrl);
}

/** A connection as seen by the UI: secrets are never sent, only whether one is set. */
/** One agent of the ACP registry, as the Connections dialog lists it. */
export interface AcpAgentView {
  id: string;
  name: string;
  version?: string;
  description?: string;
  website?: string;
  icon?: string;
  /** How it runs here: through npx/uvx, a downloaded binary, or a copy already on PATH. */
  method?: "npx" | "uvx" | "binary" | "path";
  ready: boolean;
  needsInstall: boolean;
  reason?: string;
}

export interface ConnectionView {
  id: string;
  kind: ProviderKind;
  label: string;
  /** ACP connections: the agent behind it. */
  acp?: { agentId: string; agentName: string; icon?: string; custom: boolean };
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

/** How agents may touch your files. */
export type SafetyMode = "direct" | "sandbox" | "readonly";
/** Request kind chosen in the composer. */
export type RunMode = "build" | "design";

export interface Settings {
  maxReviewRounds: number;
  /** direct: edit the project (with undo). sandbox: work on a copy, you apply. readonly: plan only. */
  safety: SafetyMode;
  /** Files agents may never read or change (glob patterns, relative to the project). */
  protectedPaths: string[];
  /** Spend fewer tokens: cheaper routing, one review round, smaller context. */
  economy: boolean;
  /** When an account hits its usage limit, continue the work on this free model. */
  freeFallback: { enabled: boolean; model: string };
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
  /** Non-secret values written as-is (e.g. a data file path). */
  fixedEnv?: Record<string, string>;
}

export type PluginRisk = "low" | "medium" | "high";

export interface PluginInfo {
  id: string;
  name: string;
  category: "memory" | "browser" | "knowledge" | "reasoning" | "computer";
  description: string;
  risk: PluginRisk;
  source: string;
  optionalEnv?: string[];
  enabled: boolean;
}

export type SkillMode = "auto" | "on" | "off";

export interface SkillPackInfo {
  id: string;
  name: string;
  description: string;
  skills: { name: string; description: string }[];
  mode: SkillMode;
}

export interface ExtensionsView {
  plugins: PluginInfo[];
  packs: SkillPackInfo[];
  browserAnyWebsite: boolean;
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

export interface UsageTotals {
  input: number;
  output: number;
  costUsd: number;
  /** Tokens served by free models. */
  freeTokens: number;
}

export interface DesignVariant {
  id: string;
  title: string;
  direction: string;
  memberId: string;
}

export type RunEvent =
  | { type: "run.started"; runId: string; project: string; prompt: string; at: number }
  | { type: "phase"; phase: "planning" | "building" | "reviewing" | "fixing"; round: number }
  | { type: "plan"; plan: Plan }
  | {
      type: "context";
      skills: string[];
      plugins: string[];
      fallback?: { id: string; name: string };
      safety?: SafetyMode;
      economy?: boolean;
    }
  | { type: "tasks.added"; tasks: PlanTask[]; round: number }
  | { type: "task.status"; taskId: string; status: TaskStatus; memberId?: string; error?: string }
  | { type: "agent.start"; streamId: string; memberId: string; title: string }
  | { type: "agent.delta"; streamId: string; text: string }
  | { type: "agent.end"; streamId: string; ok: boolean; error?: string }
  | { type: "file.changed"; path: string; change: "write" | "delete"; memberId: string }
  | { type: "review"; review: Review; round: number }
  | { type: "run.diff"; files: FileDiff[] }
  | { type: "usage"; streamId: string; memberId: string; input: number; output: number; costUsd: number; free: boolean }
  | { type: "member.limit"; memberId: string; until: number; reason: string; fallback: string }
  | { type: "protected"; paths: string[] }
  | { type: "variants"; variants: DesignVariant[] }
  | { type: "approval"; kind: "sandbox" | "design" }
  | { type: "run.done"; summary: string; changedFiles: string[]; at: number }
  | { type: "run.error"; error: string; at: number };

export interface RunSummary {
  id: string;
  project: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  /** The crew finished in a sandbox or as design variants and waits for you to apply. */
  pending?: "sandbox" | "design";
  mode?: RunMode;
  /** What you decided about pending changes. */
  resolution?: "applied" | "discarded";
  startedAt: number;
  endedAt?: number;
  /** Set when the run's file changes have been undone. */
  undoneAt?: number;
  /** True when a checkpoint exists, so the run can be undone. */
  canUndo?: boolean;
}
