import type { Connection } from "../config.js";
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from "./api.js";
import { AcpProvider } from "./acp.js";
import { agyLaunch } from "../antigravity.js";
import { ClaudeSdkProvider } from "./claude.js";
import { CliProvider } from "./cli.js";
import { CodexAppServerProvider } from "./codex.js";
import { FallbackProvider } from "./fallback.js";
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
    // Connected the way T3 Code connects them: the Agent SDK and Codex's app-server protocol,
    // with the plain CLI as a fallback when the native mode can't start.
    case "claude-cli":
      return new FallbackProvider(
        new ClaudeSdkProvider(conn),
        new CliProvider(conn),
      );
    case "codex-cli":
      return new FallbackProvider(
        new CodexAppServerProvider(conn),
        new CliProvider(conn),
      );
    case "gemini-cli":
    case "opencode-cli":
    case "qwen-cli":
      return new CliProvider(conn);
    case "acp":
      return new AcpProvider(conn);
    // Google Antigravity: its agy CLI speaks ACP (as T3 Code runs it).
    case "antigravity":
      return new AcpProvider(conn, () => agyLaunch());
  }
};
