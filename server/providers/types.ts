import type { McpServer } from "../shared.js";

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
  /** Extra environment for agent processes (e.g. MCP server secrets). */
  env?: Record<string, string>;
}

export type DeltaHandler = (text: string) => void;

export interface Provider {
  /** True when the provider edits files on disk itself (CLI agents in edit mode). */
  readonly editsFiles: boolean;
  generate(req: GenerateRequest, onDelta: DeltaHandler, signal: AbortSignal): Promise<string>;
  listModels?(signal: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {}
