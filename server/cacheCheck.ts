// A live check that prompt caching really works with your Anthropic API key: two short calls
// with the same long system prompt. The second must read it from the cache. Real API only.
import type { Connection } from "./config.js";
import { HttpError } from "./config.js";
import { AnthropicProvider } from "./providers/api.js";
import { explain } from "./health.js";

export interface CacheCheck {
  ok: boolean;
  model: string;
  first: { input: number; cached: number };
  second: { input: number; cached: number };
  message: string;
}

/** Long enough for every model's minimum cacheable prefix (up to 4096 tokens), and stable. */
const SYSTEM = [
  "You are MultiCode's cache check. Answer with the single word OK.",
  ...Array.from({ length: 400 }, (_, i) => `Reference line ${i + 1}: the crew plans, builds in parallel and reviews every change before it lands.`),
].join("\n");

export async function checkCaching(conn: Connection, signal?: AbortSignal): Promise<CacheCheck> {
  if (conn.kind !== "anthropic") throw new HttpError(400, "Caching can be checked on an Anthropic API connection");
  if (!conn.apiKey) throw new HttpError(400, "This connection has no API key: the check needs the real Anthropic API");
  const provider = new AnthropicProvider(conn);
  const model = conn.defaultModel || "claude-opus-5-5";
  const call = async (n: number) => {
    let usage = { input: 0, cached: 0 };
    await provider.generate(
      { system: SYSTEM, prompt: `Check ${n}`, model, cwd: ".", mode: "text", onUsage: (u) => (usage = { input: u.input, cached: u.cached ?? 0 }) },
      () => {},
      signal ?? AbortSignal.timeout(120_000),
    );
    return usage;
  };
  let first: { input: number; cached: number };
  let second: { input: number; cached: number };
  try {
    first = await call(1);
    second = await call(2);
  } catch (err) {
    // The same plain-language reasons the connection check gives (key rejected, quota, offline…).
    throw new HttpError(400, explain((err as Error).message, conn).message);
  }
  const ok = second.cached > 0;
  return {
    ok,
    model,
    first,
    second,
    message: ok
      ? `Caching works: the second call read ${second.cached.toLocaleString()} tokens from the cache (billed at about a tenth).`
      : "The second call read nothing from the cache. The model may not support caching, or the cache expired between calls.",
  };
}
