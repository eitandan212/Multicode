// Is a connection working, and if not, why, in plain words, with the one thing to do about it.
// Free and fast: nothing here asks a model to write anything.
import type { Connection } from "./config.js";
import { CLI_SPECS, findBinary } from "./providers/cli.js";
import type { Provider } from "./providers/types.js";
import type { SignIn } from "./signin.js";
import { API_KINDS, type ConnectionHealth } from "./shared.js";

export type { ConnectionHealth } from "./shared.js";

/** Turns an error from any agent or API into what it means and what to do. */
export function explain(raw: string, conn: Pick<Connection, "kind" | "baseUrl" | "label">): ConnectionHealth {
  const msg = raw.replace(/^Error:\s*/, "").trim();
  const api = API_KINDS.includes(conn.kind);
  const detail = msg.slice(0, 400);
  if (/needs node\.js|npx\b.*not found|"npx" not found|node(\.js)? isn't installed/i.test(msg))
    return { status: "problem", action: "node", message: "Needs Node.js. Install the LTS version from nodejs.org, then check again.", detail };
  if (/isn't installed|not installed|not found|ENOENT|press install|needs install/i.test(msg) && !api)
    return { status: "install", action: "install", message: `${conn.label} isn't installed on this computer yet.`, detail };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo|socket hang up|connect(ion)? (refused|error)/i.test(msg))
    return {
      status: "problem",
      // A local app that isn't running needs starting, not a new key.
      action: api && !/localhost|127\.0\.0\.1/.test(conn.baseUrl ?? "") ? "edit" : undefined,
      message: conn.baseUrl && /localhost|127\.0\.0\.1/.test(conn.baseUrl)
        ? `Nothing is answering at ${conn.baseUrl}. Start the app it belongs to (Ollama, LM Studio, FreeLLMAPI…), then check again.`
        : `Couldn't reach ${conn.baseUrl || "the service"}. Check the internet connection and the address.`,
      detail,
    };
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}(api )?key|incorrect api key|permission denied|forbidden|authentication/i.test(msg) && api)
    return { status: "problem", action: "edit", message: "The API key was rejected. Paste a valid key.", detail };
  if (/sign(ed)? in|log ?in|authenticat|oauth|credential/i.test(msg))
    return { status: "sign-in", action: "sign-in", message: `${conn.label} needs you to sign in.`, detail };
  if (/\b429\b|rate.?limit|quota|usage limit|limit reached|out of credits|billing/i.test(msg))
    return { status: "problem", message: "The account is out of quota right now. It will work again once the limit resets.", detail };
  if (/timed? ?out|didn't answer|aborted/i.test(msg))
    return { status: "problem", message: `${conn.label} didn't answer in time. Check again in a moment.`, detail };
  if (/\b404\b|model.{0,30}(not found|does not exist)/i.test(msg) && api)
    return { status: "problem", action: "edit", message: "The address or model name looks wrong.", detail };
  return { status: "problem", message: `${conn.label} isn't working: ${msg.slice(0, 160)}`, detail };
}

/** Checks one connection without spending tokens. */
export async function checkConnection(
  conn: Connection,
  provider: Provider,
  signIn: SignIn,
): Promise<ConnectionHealth> {
  try {
    if (conn.kind === "claude-cli" || conn.kind === "codex-cli" || conn.kind === "antigravity") {
      const a = await signIn.access(conn.kind);
      if (!a.installed) return { status: "install", action: "install", message: `${conn.label} isn't installed on this computer yet.` };
      if (!a.signedIn)
        return a.problem
          ? explain(a.problem, conn)
          : { status: "sign-in", action: "sign-in", message: `Sign in to use your ${conn.label} subscription.` };
      return { status: "ready", message: a.account ? `Signed in as ${a.account}` : "Signed in and ready" };
    }
    if (conn.kind === "gemini-cli" || conn.kind === "opencode-cli" || conn.kind === "qwen-cli") {
      if (!(await findBinary(CLI_SPECS[conn.kind].binary)))
        return { status: "install", action: "install", message: `${conn.label} isn't installed on this computer yet.` };
      return { status: "ready", message: "Installed and ready" };
    }
    // APIs: listing models checks the address and the key. ACP agents: a session must start.
    if (!provider.listModels) return { status: "ready", message: "Ready" };
    const models = await provider.listModels(AbortSignal.timeout(API_KINDS.includes(conn.kind) ? 20_000 : 120_000));
    return {
      status: "ready",
      message: API_KINDS.includes(conn.kind)
        ? models.length
          ? `Works · ${models.length} model${models.length === 1 ? "" : "s"} available`
          : "Works"
        : "Started and ready",
    };
  } catch (err) {
    return explain((err as Error).message, conn);
  }
}
