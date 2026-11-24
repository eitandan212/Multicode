import type { Connection } from "../config.js";
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from "./api.js";
import { CliProvider } from "./cli.js";
import type { Provider } from "./types.js";

export type ProviderFactory = (conn: Connection) => Provider;

export const createProvider: ProviderFactory = (conn) => {
  switch (conn.kind) {
    case "anthropic":
      return new AnthropicProvider(conn);
    case "openai":
    case "openai-compatible":
      return new OpenAIProvider(conn);
    case "gemini":
      return new GeminiProvider(conn);
    case "claude-cli":
    case "codex-cli":
    case "gemini-cli":
    case "opencode-cli":
    case "qwen-cli":
      return new CliProvider(conn);
  }
};
