import type { ApprovalAsk, McpServer } from "../shared.js";

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** Base64, no data: prefix. */
  data: string;
}

export interface GenerateRequest {
  system: string;
  prompt: string;
  model?: string;
  /** Project folder. CLI agents run inside it. */
  cwd: string;
  /**
   * "text": answer only (planning / review). CLI agents run read-only.
   * "edit": the agent may change files. API agents still answer with file blocks.
   */
  mode: "text" | "edit";
  /** Shared MCP servers (CLI agents only; files-based harnesses get them through sync). */
  mcpServers?: McpServer[];
  /**
   * Shared MCP servers to keep off for this call (answering and planning need no browser or
   * desktop tools). Agents that read them from their own config files get them switched off.
   */
  quietMcp?: McpServer[];
  /** Extra environment for agent processes (e.g. MCP server secrets). */
  env?: Record<string, string>;
  /** Pictures for the model to look at (API models with vision; agents open the files themselves). */
  images?: ImageInput[];
  /** Called with token usage when the provider reports it. */
  onUsage?: (u: Usage) => void;
  /**
   * Set when actions need the user's approval: agents that can pause before an action
   * (Claude Agent SDK, ACP) ask here and only act on a yes. Absent: nothing asks.
   */
  approve?: (a: ApprovalAsk) => Promise<boolean>;
}

export interface Usage {
  /** New input tokens (cache writes included, cache reads not). */
  input: number;
  output: number;
  /** Input re-read from the provider's prompt cache: cheap or free, and repeated on every step. */
  cached?: number;
  costUsd?: number;
}

/**
 * True when an error means the account is out of quota or rate-limited, i.e. the work should
 * move to another model instead of failing.
 */
export function isLimitError(message: string): boolean {
  return /\b429\b|rate.?limit|too many requests|quota|insufficient_quota|usage limit|limit reached|reached your|credit balance|out of credits|no credits|exceeded your current|billing|resource_exhausted|overloaded|capacity|plan limit|upgrade (your|to)/i.test(
    message,
  );
}

/** Reads "try again in 2h 15m" / "in 37 minutes" / "resets at 3pm"-style hints; defaults to an hour. */
export function limitCooldownMs(message: string): number {
  const h = /(\d+)\s*h(?:ours?)?/i.exec(message);
  const m = /(\d+)\s*m(?:in(?:utes?)?)?\b/i.exec(message);
  const total =
    (h ? Number(h[1]) * 3600_000 : 0) + (m ? Number(m[1]) * 60_000 : 0);
  if (total > 0 && total < 7 * 24 * 3600_000) return total;
  const hard =
    /quota|credit|usage limit|limit reached|reached your|billing|exceeded your current|plan limit|upgrade/i.test(
      message,
    );
  return hard ? 3600_000 : 120_000;
}

export type DeltaHandler = (text: string) => void;

export interface Provider {
  /** True when the provider edits files on disk itself (CLI agents in edit mode). */
  readonly editsFiles: boolean;
  generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string>;
  listModels?(signal: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {}
