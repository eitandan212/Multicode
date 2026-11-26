// One-click setup for the subscription agents (as T3 Code does it): install the CLI, sign in
// from the app, and see who you're signed in as. No terminal needed.
//
//   Claude Code: `claude auth login` (it opens the browser; a code can be pasted back) and
//                `claude auth status --json`.
//   Codex:       the app-server's own ChatGPT sign-in (`account/login/start`), the same flow
//                Codex's apps use.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HttpError } from "./config.js";
import { CLI_SPECS, findBinary, resolveLaunch } from "./providers/cli.js";
import { CodexAppServerProvider } from "./providers/codex.js";
import { AGY_ENV, AUTH_PREFIX, agyStatus, findAgy, installAgy } from "./antigravity.js";
import type { AgentAccess, SignInFlow, SignInKind } from "./shared.js";

export type { AgentAccess, SignInFlow, SignInKind } from "./shared.js";
export const SIGN_IN_KINDS: SignInKind[] = ["claude-cli", "codex-cli", "antigravity"];

interface LiveFlow extends SignInFlow {
  stop: () => void;
  sendCode?: (code: string) => void;
  at: number;
}

const URL_RE = /https:\/\/[^\s"'<>]+/;
const FLOW_TTL = 15 * 60_000;

function checkKind(kind: unknown): SignInKind {
  if (!SIGN_IN_KINDS.includes(kind as SignInKind))
    throw new HttpError(400, "sign-in is available for Claude Code, Codex and Antigravity");
  return kind as SignInKind;
}

/** Runs a CLI to completion and returns its output (for short status commands). */
async function runCli(binary: string, args: string[], ms = 20_000): Promise<{ code: number; out: string }> {
  const bin = await findBinary(binary);
  if (!bin) throw new HttpError(404, `${binary} isn't installed`);
  const l = await resolveLaunch(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(l.command, [...l.prefix, ...args], {
      env: { ...process.env, ...(l.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), ms);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

async function claudeStatus(): Promise<{ signedIn: boolean; account?: string }> {
  const r = await runCli(CLI_SPECS["claude-cli"].binary, ["auth", "status", "--json"]);
  const json = r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1);
  const s = JSON.parse(json || "{}") as {
    loggedIn?: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
  };
  return {
    signedIn: s.loggedIn === true,
    ...(s.loggedIn
      ? {
          account:
            [s.email, s.subscriptionType].filter(Boolean).join(" · ") ||
            (s.authMethod === "api_key" ? "API key" : "Claude account"),
        }
      : {}),
  };
}

const codex = () =>
  new CodexAppServerProvider({ id: "signin", kind: "codex-cli", label: "Codex" });

export class SignIn {
  private flows = new Map<string, LiveFlow>();

  async access(kindIn: unknown): Promise<AgentAccess> {
    const kind = checkKind(kindIn);
    const installed =
      kind === "antigravity" ? Boolean(await findAgy()) : Boolean(await findBinary(CLI_SPECS[kind].binary));
    if (!installed) return { kind, installed, signedIn: false };
    try {
      const s =
        kind === "claude-cli"
          ? await claudeStatus()
          : kind === "codex-cli"
            ? await codex().account()
            : await agyStatus();
      return { kind, installed, ...s };
    } catch (err) {
      return { kind, installed, signedIn: false, problem: (err as Error).message.slice(0, 300) };
    }
  }

  view(id: string): SignInFlow {
    this.prune();
    const f = this.flows.get(id);
    if (!f) throw new HttpError(404, "That sign-in has ended. Start it again.");
    const { stop: _s, sendCode: _c, at: _a, ...view } = f;
    return view;
  }

  /** Starts signing in. The returned flow is polled until it's done. */
  async start(kindIn: unknown): Promise<SignInFlow> {
    const kind = checkKind(kindIn);
    if (kind === "antigravity" ? !(await findAgy()) : !(await findBinary(CLI_SPECS[kind].binary)))
      throw new HttpError(409, "Install it first (press Install)");
    // One sign-in per agent at a time.
    for (const f of this.flows.values())
      if (f.kind === kind && f.state === "waiting") f.stop();
    const flow: LiveFlow = {
      id: randomUUID(),
      kind,
      state: "waiting",
      at: Date.now(),
      stop: () => {},
    };
    this.flows.set(flow.id, flow);
    if (kind === "codex-cli") await this.startCodex(flow);
    else if (kind === "antigravity") await this.startAntigravity(flow);
    else await this.startClaude(flow);
    return this.view(flow.id);
  }

  code(id: string, code: unknown): void {
    const f = this.flows.get(id);
    if (!f?.sendCode || f.state !== "waiting") throw new HttpError(409, "This sign-in isn't waiting for a code");
    if (typeof code !== "string" || !code.trim() || code.length > 4000)
      throw new HttpError(400, "paste the code from the sign-in page");
    f.sendCode(code.trim());
  }

  cancel(id: string): void {
    const f = this.flows.get(id);
    if (f?.state === "waiting") {
      f.stop();
      f.state = "error";
      f.message = "Cancelled";
    }
  }

  private async startCodex(flow: LiveFlow) {
    const login = await codex().startLogin();
    flow.url = login.url;
    flow.stop = login.cancel;
    void login.done.then((r) => {
      if (flow.state !== "waiting") return;
      flow.state = r.ok ? "done" : "error";
      if (!r.ok) flow.message = r.error ?? "Sign-in didn't finish";
    });
    // Codex's callback server gives up after a while; so do we.
    setTimeout(() => flow.state === "waiting" && login.cancel(), FLOW_TTL).unref();
  }

  private async startClaude(flow: LiveFlow) {
    const bin = (await findBinary(CLI_SPECS["claude-cli"].binary))!;
    const l = await resolveLaunch(bin);
    const child: ChildProcess = spawn(l.command, [...l.prefix, "auth", "login", "--claudeai"], {
      env: { ...process.env, ...(l.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const onOut = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
      const url = URL_RE.exec(out)?.[0];
      if (url && !flow.url) flow.url = url;
      if (/paste|code/i.test(out) && flow.url) flow.wantsCode = true;
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onOut);
    flow.sendCode = (code) => child.stdin?.write(code + "\n");
    // Claude may finish through its own browser callback and linger: watch for the moment the
    // status turns signed-in (when it already was, wait for the command to end instead).
    const wasSignedIn = (await claudeStatus().catch(() => undefined))?.signedIn === true;
    const poll = setInterval(async () => {
      if (flow.state !== "waiting") return clearInterval(poll);
      if (wasSignedIn) return;
      const s = await claudeStatus().catch(() => undefined);
      if (s?.signedIn && flow.state === "waiting") {
        flow.state = "done";
        clearInterval(poll);
        child.kill();
      }
    }, 2500);
    flow.stop = () => {
      clearInterval(poll);
      child.kill();
    };
    child.on("error", (e) => {
      clearInterval(poll);
      flow.state = "error";
      flow.message = e.message;
    });
    child.on("close", async (code) => {
      clearInterval(poll);
      if (flow.state !== "waiting") return;
      const s = await claudeStatus().catch(() => undefined);
      flow.state = code === 0 && s?.signedIn ? "done" : "error";
      if (flow.state === "error")
        flow.message =
          out
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(-2)
            .join(" ")
            .slice(0, 300) || "Sign-in didn't finish";
    });
    setTimeout(() => flow.state === "waiting" && flow.stop(), FLOW_TTL).unref();
  }

  /**
   * Antigravity: `agy acp --login` prints a Google link; the page shows a code that is pasted
   * back to it. Done once a probe session starts signed in (or the command ends well).
   */
  private async startAntigravity(flow: LiveFlow) {
    const agy = (await findAgy())!;
    const child: ChildProcess = spawn(agy, ["acp", "--login"], {
      env: { ...process.env, ...AGY_ENV },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let checking = false;
    const onOut = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
      const at = out.indexOf(AUTH_PREFIX);
      const url = at >= 0 ? URL_RE.exec(out.slice(at + AUTH_PREFIX.length))?.[0] : URL_RE.exec(out)?.[0];
      if (url && !flow.url) {
        flow.url = url;
        flow.wantsCode = true;
      }
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onOut);
    const finish = (state: "done" | "error", message?: string) => {
      if (flow.state !== "waiting") return;
      clearInterval(poll);
      flow.state = state;
      if (message) flow.message = message;
      child.kill();
    };
    // After the code, check every few seconds whether a session now starts signed in.
    let codeAt = 0;
    const poll = setInterval(async () => {
      if (!codeAt || checking || flow.state !== "waiting") return;
      checking = true;
      const s = await agyStatus(30_000).catch(() => undefined);
      checking = false;
      if (s?.signedIn) finish("done");
      else if (Date.now() - codeAt > 3 * 60_000) finish("error", "Antigravity didn't accept the sign-in. Try again.");
    }, 6000);
    flow.sendCode = (code) => {
      codeAt = Date.now();
      child.stdin?.write(code + "\n");
    };
    flow.stop = () => {
      clearInterval(poll);
      child.kill();
    };
    child.on("error", (e) => finish("error", e.message));
    child.on("close", async (code) => {
      if (flow.state !== "waiting") return;
      const s = await agyStatus(30_000).catch(() => undefined);
      if (s?.signedIn) finish("done");
      else
        finish(
          "error",
          out.split("\n").map((x) => x.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 300) ||
            `Antigravity's sign-in ended (${code ?? "stopped"})`,
        );
    });
    setTimeout(() => flow.state === "waiting" && flow.stop(), FLOW_TTL).unref();
  }

  private prune() {
    for (const [id, f] of this.flows)
      if (Date.now() - f.at > FLOW_TTL * 2) this.flows.delete(id);
  }
}

/** The npm package behind a CLI, from its install hint ("npm i -g <package> → ..."). */
export function npmPackageOf(kind: keyof typeof CLI_SPECS): string | undefined {
  return /npm i(?:nstall)? -g (\S+)/.exec(CLI_SPECS[kind].install)?.[1];
}

/**
 * Installs Cursor's agent with Cursor's own installer (cursor.com/install), for this user only:
 * it lands in ~/.local/bin (macOS, Linux) or the user's profile (Windows). Runs on your click.
 */
function installCursor(): Promise<{ ok: boolean; output: string }> {
  const win = process.platform === "win32";
  const [cmd, args] = win
    ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm 'https://cursor.com/install?win32=true' | iex"]]
    : ["bash", ["-c", "set -o pipefail; curl -fsS https://cursor.com/install | bash"]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(-6000)));
    child.stderr.on("data", (d) => (out = (out + d).slice(-6000)));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().split("\n").slice(-12).join("\n") });
    });
  });
}

/** Installs an agent CLI with npm (global, for this user). */
export async function installAgent(
  kind: keyof typeof CLI_SPECS | "antigravity",
): Promise<{ ok: boolean; output: string }> {
  if (kind === "antigravity") return installAgy();
  if (kind === "cursor-cli") return installCursor();
  const pkg = npmPackageOf(kind);
  if (!pkg) throw new HttpError(400, "this agent isn't installed with npm");
  const npm = await findBinary("npm");
  if (!npm)
    throw new HttpError(
      409,
      "Node.js isn't installed. Get it from nodejs.org (LTS), then press Install again.",
    );
  const l = await resolveLaunch(npm);
  return new Promise((resolve) => {
    const child = spawn(l.command, [...l.prefix, "install", "-g", pkg], {
      env: { ...process.env, ...(l.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(-6000)));
    child.stderr.on("data", (d) => (out = (out + d).slice(-6000)));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().split("\n").slice(-12).join("\n") });
    });
  });
}
