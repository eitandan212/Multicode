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
  /** Cursor's agent CLI (`agent`), with your Cursor account. */
  | "cursor-cli"
  /** Google Antigravity's agent (`agy acp`), with your Google account. */
  | "antigravity"
  /** Any agent that speaks the Agent Client Protocol (from the ACP registry or a custom command). */
  | "acp";

export const API_KINDS: ProviderKind[] = [
  "anthropic",
  "openai",
  "gemini",
  "openai-compatible",
];
export const SUBSCRIPTION_KINDS: ProviderKind[] = [
  "claude-cli",
  "codex-cli",
  "cursor-cli",
  "antigravity",
];
export const OPEN_SOURCE_KINDS: ProviderKind[] = ["opencode-cli", "qwen-cli"];
/** Agents run through their plain CLI. Gemini CLI stays for connections made before Antigravity. */
export const CLI_KINDS: ProviderKind[] = [
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "cursor-cli",
  ...OPEN_SOURCE_KINDS,
];
/** Kinds whose agent works in the project folder and edits files itself. */
export const AGENT_KINDS: ProviderKind[] = [...CLI_KINDS, "antigravity", "acp"];

export const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  gemini: "Google Gemini API",
  "openai-compatible": "OpenAI-compatible API",
  "claude-cli": "Claude subscription (Claude Code)",
  "codex-cli": "ChatGPT subscription (Codex CLI)",
  "gemini-cli": "Google subscription (Gemini CLI)",
  antigravity: "Google subscription (Antigravity)",
  "opencode-cli": "OpenCode (75+ providers, free models)",
  "qwen-cli": "Qwen Code (free Qwen account)",
  "cursor-cli": "Cursor subscription (Cursor CLI)",
  acp: "Any ACP agent (Agent Client Protocol)",
};

/** The name people know each harness or service by, shown with its logo. */
export const HARNESS_NAMES: Record<ProviderKind, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  "opencode-cli": "OpenCode",
  "qwen-cli": "Qwen Code",
  "cursor-cli": "Cursor",
  acp: "ACP agent",
  anthropic: "Claude API",
  openai: "OpenAI API",
  gemini: "Gemini API",
  "openai-compatible": "OpenAI-compatible",
};

/** FreeLLMAPI (github.com/tashfeenahmed/freellmapi): 80+ free providers behind one /v1 endpoint. */
export const FREELLMAPI_URL = "http://localhost:3001/v1";
export function isFreeLlmApi(baseUrl?: string): boolean {
  return /freellmapi|:3001(\/|$)/i.test(baseUrl ?? "");
}
/** Endpoints that cost nothing to call: a local server, or a free-tier aggregator. */
export function isFreeEndpoint(baseUrl?: string): boolean {
  return (
    isFreeLlmApi(baseUrl) ||
    /localhost|127\.0\.0\.1|\[::1\]/i.test(baseUrl ?? "")
  );
}

const ENDPOINT_BRANDS: [RegExp, string][] = [
  [/freellmapi|:3001(\/|$)/i, "FreeLLMAPI"],
  [/openrouter/i, "OpenRouter"],
  [/groq/i, "Groq"],
  [/deepseek/i, "DeepSeek"],
  [/mistral/i, "Mistral"],
  [/x\.ai/i, "Grok (xAI)"],
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
  const id = model
    .trim()
    .split("/")
    .pop()!
    .replace(/:free$|-free$/i, "");
  if (!id) return model;
  if (/^auto$/i.test(id)) return "Auto Router";
  const out: string[] = [];
  for (const raw of id.split(/[-_\s]+/).filter(Boolean)) {
    const t = raw.toLowerCase();
    const prev = out[out.length - 1];
    if (
      /^\d+$/.test(t) &&
      prev &&
      /^\d+(\.\d+)?$/.test(prev) &&
      !prev.includes(".") &&
      t.length <= 2
    ) {
      out[out.length - 1] = `${prev}.${t}`; // "5", "5" → "5.5"
    } else if (/^\d+(\.\d+)?$/.test(t) && prev === "GPT") {
      out[out.length - 1] = `GPT-${t}`;
    } else if (BRANDS[t]) out.push(BRANDS[t]);
    else if (/^v\d/.test(t)) out.push(t.toUpperCase());
    else if (/^\d+(\.\d+)?[bkm]$/.test(t)) out.push(t.toUpperCase());
    else if (/^o\d/.test(t))
      out.push(t); // OpenAI o-series stays lowercase
    else out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out.join(" ");
}

export const isFreeModel = (model?: string) =>
  Boolean(model && /(-free|:free|big-pickle)$/i.test(model));

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
export function connectionName(
  kind: ProviderKind,
  baseUrl?: string,
  model?: string,
): string {
  // FreeLLMAPI's router models: "auto", "auto:coding", "fusion" (many models + a judge).
  if (model && isFreeLlmApi(baseUrl)) {
    const m = model.toLowerCase();
    if (m === "auto") return "FreeLLMAPI Auto (free)";
    if (m.startsWith("auto:"))
      return `FreeLLMAPI ${m.slice(5).replace(/^\w/, (c) => c.toUpperCase())} (free)`;
    if (m === "fusion") return "FreeLLMAPI Fusion (free)";
    return `${modelDisplayName(model)} (free)`;
  }
  if (model)
    return `${modelDisplayName(model)}${isFreeModel(model) ? " (free)" : ""}`;
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
  /** Names of extra request headers (their values stay on the server, like the key). */
  headerNames?: string[];
  effort?: Effort;
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
  /** The specialist agent it was added as (see server/agents.ts); shown as a tag. */
  preset?: string;
}

export type DispatchMode = "smart" | "balanced";

/** How agents may touch your files. */
export type SafetyMode = "direct" | "sandbox" | "readonly";
/**
 * As in Claude Code. ask: you approve every file change and tool call. edits: file changes go
 * through, other tools ask. all: nothing asks (reads never ask).
 */
export type ApprovalMode = "ask" | "edits" | "all";

/** Something an agent wants to do that needs your yes. */
export interface ApprovalAsk {
  /** edit: a change before it happens. tool: a tool call. review: a change that already
   *  happened (agents that can't be stopped mid-way); declining reverts it. */
  kind: "edit" | "tool" | "review";
  title: string;
  /** What exactly: the new content or a diff, trimmed. */
  detail?: string;
  files?: string[];
}
/** Request kind chosen in the composer. */
/** build: the crew splits the work. design: several designs. compare: several models do the same task. */
export type RunMode = "build" | "design" | "compare";

export interface Settings {
  maxReviewRounds: number;
  /** Set once the 2026-11 token-saving defaults were applied to an older config. */
  savingDefaults?: number;
  /** direct: edit the project (with undo). sandbox: work on a copy, you apply. readonly: plan only. */
  safety: SafetyMode;
  /** Which agent actions wait for your approval (default: all of them). */
  approvals: ApprovalMode;
  /** The first-run setup was finished or skipped. */
  onboarded?: boolean;
  /** Files agents may never read or change (glob patterns, relative to the project). */
  protectedPaths: string[];
  /** Spend fewer tokens: cheaper routing, one review round, smaller context. */
  economy: boolean;
  /** When an account hits its usage limit, continue the work on this free model. */
  freeFallback: { enabled: boolean; model: string };
  /** smart: the dispatcher assigns each task to the best-fitting agent. balanced: first free agent. */
  dispatch: DispatchMode;
  /**
   * A free or cheap model that runs the crew: it picks the team in Auto and assigns every task,
   * so the strong models spend their effort on thinking and building. auto: use a free
   * connection, else the free OpenCode model. pick: this connection. off: the planner dispatches.
   */
  manager: ManagerSetting;
  /** Your commands that run on events (as Claude Code hooks). */
  hooks?: Hook[];
}

export type HookEvent = "UserPromptSubmit" | "PostToolUse" | "Notification" | "Stop";
export interface Hook {
  event: HookEvent;
  command: string;
  /** PostToolUse only: a glob on the changed file's path. */
  matcher?: string;
}

/** The manager a run would get right now (null in state when there is none). */
export interface ManagerView {
  name: string;
  kind: ProviderKind;
  /** Missing for MultiCode's built-in free OpenCode model. */
  connectionId?: string;
  model?: string;
  baseUrl?: string;
  free: boolean;
}

export interface ManagerSetting {
  mode: "auto" | "pick" | "off";
  connectionId?: string;
  model?: string;
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
  /** Set for a folder opened from elsewhere on this computer (the crew works in it directly). */
  path?: string;
  /** The project's emoji, shown instead of its initials. */
  emoji?: string;
  /** Runs after the crew builds (e.g. "npm test"); a failure becomes a fix. */
  check?: string;
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
  /** Set when the message asked for nothing to be built (a greeting, a question): the answer. */
  reply?: string;
  /** Questions back to you before anything is built (each may offer likely answers). */
  questions?: { question: string; options?: string[] }[];
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
  /** Files this version changed (set when it finishes). */
  files?: string[];
}

export type RunEvent =
  | ({ type: "approval.request"; id: string; memberId: string } & ApprovalAsk)
  | { type: "approval.resolved"; id: string; allow: boolean; always?: boolean }
  | {
      type: "run.started";
      runId: string;
      project: string;
      prompt: string;
      at: number;
    }
  | {
      type: "phase";
      phase: "planning" | "building" | "checking" | "reviewing" | "fixing";
      round: number;
    }
  | { type: "plan"; plan: Plan }
  | {
      type: "context";
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
      sleep?: boolean;
    }
  | { type: "tasks.added"; tasks: PlanTask[]; round: number }
  | {
      type: "task.status";
      taskId: string;
      status: TaskStatus;
      memberId?: string;
      error?: string;
    }
  | { type: "agent.start"; streamId: string; memberId: string; title: string }
  | { type: "agent.delta"; streamId: string; text: string }
  | { type: "agent.end"; streamId: string; ok: boolean; error?: string }
  | {
      type: "file.changed";
      path: string;
      change: "write" | "delete";
      memberId: string;
    }
  | { type: "review"; review: Review; round: number }
  | { type: "check"; command: string; ok: boolean; output: string; ms: number; round: number }
  | { type: "hook"; event: HookEvent; command: string; ok: boolean; output: string }
  /** The architect needs answers before building. */
  | { type: "questions"; questions: { question: string; options?: string[] }[] }
  /** A request was too long for the model: it was compacted (characters before/after) and sent again. */
  | { type: "compacted"; streamId: string; memberId: string; from: number; to: number }
  | { type: "run.diff"; files: FileDiff[] }
  | {
      type: "usage";
      streamId: string;
      memberId: string;
      input: number;
      output: number;
      /** Prompt-cache reads, kept apart from `input`. */
      cached?: number;
      costUsd: number;
      free: boolean;
    }
  | {
      type: "member.limit";
      memberId: string;
      until: number;
      reason: string;
      fallback: string;
    }
  | { type: "protected"; paths: string[] }
  | { type: "variants"; variants: DesignVariant[] }
  | { type: "approval"; kind: "sandbox" | "design" }
  /** Compare: which version the reviewer recommends, and why. */
  | { type: "verdict"; best?: string; why: string; files: Record<string, string[]> }
  | { type: "run.done"; summary: string; changedFiles: string[]; at: number }
  | { type: "run.error"; error: string; at: number };

/** Who works on a run: MultiCode's automatic team, your crew, or one model alone. */
export type TeamChoice =
  | { kind: "auto" }
  | { kind: "crew" }
  | { kind: "solo"; connectionId: string; model?: string };

export interface RunSummary {
  id: string;
  project: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  /** The crew finished in a sandbox or as design variants and waits for you to apply. */
  pending?: "sandbox" | "design";
  mode?: RunMode;
  team?: TeamChoice;
  /** Started in Sleep mode: the crew worked alone, approving its own actions. */
  sleep?: boolean;
  /** What you decided about pending changes. */
  resolution?: "applied" | "discarded";
  startedAt: number;
  endedAt?: number;
  /** Set when the run's file changes have been undone. */
  undoneAt?: number;
  /** True when a checkpoint exists, so the run can be undone. */
  canUndo?: boolean;
  /** Follow-ups share a thread: the first run's id. Unset for a run that starts its own thread. */
  threadId?: string;
  /** The run this one follows up on. */
  parentId?: string;
  /** What the crew answered (trimmed), so later turns remember it. */
  reply?: string;
  /** Files the run changed (at most 30). */
  changedFiles?: string[];
  /** Chat settings, kept on the chat's first run: your title, pinned, archived (hidden from the list). */
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** Default model strength when a connection names no model (the harness picks its own). */
const KIND_STRENGTH: Partial<Record<ProviderKind, number>> = {
  "claude-cli": 3,
  "codex-cli": 3,
  "cursor-cli": 3,
  anthropic: 3,
  openai: 3,
  "gemini-cli": 2,
  antigravity: 3,
  gemini: 2,
  acp: 2,
};

/**
 * A rough capability rank (1 = light/free, 2 = strong, 3 = frontier), used only to decide
 * who plans and reviews in Auto. It never blocks a model; unknown models rank in the middle.
 */
export function modelStrength(kind: ProviderKind, model = ""): number {
  const m = model.toLowerCase();
  if (!m) return KIND_STRENGTH[kind] ?? 1;
  if (isFreeModel(m)) return 1;
  if (/(mini|nano|lite|haiku|flash-lite|small|tiny|[^\d]\d{1,2}b\b)/.test(m))
    return 1;
  if (
    /(opus|fable|gpt-5|\bo[34]\b|gemini-(2\.5-pro|[3-9])|grok-4|claude-sonnet-5)/.test(
      m,
    )
  )
    return 3;
  if (
    /(sonnet|gpt-4\.1|gpt-4o|gemini|deepseek|qwen3|kimi|glm-4|codestral|mistral-large|grok|llama-4)/.test(
      m,
    )
  )
    return 2;
  return 2;
}

/** Agents MultiCode can install and sign in to from the app. */
export type SignInKind = "claude-cli" | "codex-cli" | "antigravity";

export interface AgentAccess {
  kind: SignInKind;
  installed: boolean;
  signedIn: boolean;
  /** Who: an email, a plan, or how (API key). */
  account?: string;
  /** Set when the status couldn't be read. */
  problem?: string;
}

export interface SignInFlow {
  id: string;
  kind: SignInKind;
  state: "waiting" | "done" | "error";
  /** The page to open (the agent usually opens it by itself too). */
  url?: string;
  /** True when the agent asked for a code from the sign-in page. */
  wantsCode?: boolean;
  message?: string;
}


/** A connection's health, in plain words, with the one thing to do about it. */
export interface ConnectionHealth {
  status: "ready" | "install" | "sign-in" | "problem";
  message: string;
  /** install: one-click install; sign-in: the sign-in window; edit: change key or address; node: get Node.js. */
  action?: "install" | "sign-in" | "edit" | "node";
  /** The original error, for the curious. */
  detail?: string;
}

/** One usage window of a subscription (as Claude's /usage shows it). */
export interface UsageWindow {
  id: string;
  /** e.g. "Session (5 hours)", "Weekly", "Weekly · Opus". */
  label: string;
  /** 0-100. */
  usedPercent: number;
  /** ISO time it resets. */
  resetsAt?: string;
}

/** A subscription's limits right now. */
export interface AccountUsage {
  connectionId: string;
  label: string;
  kind: ProviderKind;
  plan?: string;
  windows: UsageWindow[];
  /** Extra / pay-as-you-go credits, when the plan has them. */
  extra?: string;
  /** Why nothing could be read. */
  error?: string;
  checkedAt: number;
}

/** A project's version control, as the Changes panel shows it. */
export interface GitStatus {
  repo: boolean;
  /** False when git itself isn't installed. */
  installed: boolean;
  branch?: string;
  /** "owner/repo" when the remote is on GitHub. */
  github?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: { path: string; status: "modified" | "added" | "deleted" | "renamed" | "conflict" }[];
}

/** How hard a model thinks before answering. Unset: the model's own default. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Connections whose effort MultiCode can set. */
export const EFFORT_KINDS: ProviderKind[] = ["claude-cli", "codex-cli", "anthropic"];

/**
 * How many tokens a model can read at once (its context window), from its kind and name. A
 * best estimate for the context ring; unknown models count as 128k.
 */
export function contextWindow(kind: ProviderKind, model = ""): number {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m) || kind === "anthropic" || kind === "claude-cli") {
    if (/haiku-4|claude-3|sonnet-4-5|opus-4-5|opus-4-1|sonnet-4-0|opus-4-0/.test(m)) return 200_000;
    return 1_000_000;
  }
  if (/gemini/.test(m) || kind === "gemini" || kind === "gemini-cli" || kind === "antigravity") return 1_000_000;
  if (/gpt-4\.1/.test(m)) return 1_000_000;
  if (/gpt-5|codex|o3|o4/.test(m) || kind === "codex-cli") return 400_000;
  if (/gpt-4o|gpt-4-turbo/.test(m)) return 128_000;
  if (/qwen.*(coder|max)|kimi|glm-4\.[56]|deepseek-v3/.test(m)) return 128_000;
  return 128_000;
}
