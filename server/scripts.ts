// Project scripts (as T3 Code's project scripts): your own commands per project ("npm run dev",
// "npm test"…), started with one click. Each runs in the project folder; its output is kept (the
// last part) for the Run tab, a local address it prints becomes a link, and Stop ends the whole
// process tree. Suggestions come from package.json.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./config.js";

export interface ProjectScript {
  id: string;
  name: string;
  command: string;
}

export interface ScriptState {
  id: string;
  status: "idle" | "running" | "done" | "failed" | "stopped";
  exitCode?: number | null;
  startedAt?: number;
  endedAt?: number;
  /** A local address the script printed (a dev server), to open in the preview. */
  url?: string;
  /** Output lines since `from` (the caller passes the count it already has). */
  lines: string[];
  /** Total lines produced so far (send it back as `from` to get only new ones). */
  total: number;
}

const MAX_SCRIPTS = 20;
const MAX_LINES = 2000;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function cleanScripts(raw: unknown): ProjectScript[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "scripts must be a list");
  if (raw.length > MAX_SCRIPTS) throw new HttpError(400, `${MAX_SCRIPTS} scripts at most`);
  const seen = new Set<string>();
  return raw.map((s: unknown) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const command = typeof o.command === "string" ? o.command.trim() : "";
    if (!name) throw new HttpError(400, "Every script needs a name");
    if (!command || command.length > 500 || /[\r\n]/.test(command))
      throw new HttpError(400, `"${name}": the command must be one line (500 characters at most)`);
    let id = typeof o.id === "string" && ID.test(o.id) ? o.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "script";
    for (let n = 2; seen.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    seen.add(id);
    return { id, name, command };
  });
}

/** Scripts worth offering from package.json (dev, start, test, build, lint…). */
export async function suggestScripts(root: string): Promise<ProjectScript[]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const names = Object.keys(pkg.scripts ?? {});
    const order = ["dev", "start", "test", "build", "lint", "preview", "typecheck"];
    const runner = await detectRunner(root);
    return names
      .filter((n) => order.includes(n))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((n) => ({ id: n, name: n[0]!.toUpperCase() + n.slice(1), command: `${runner} ${n === "test" || n === "start" ? n : `run ${n}`}` }));
  } catch {
    return [];
  }
}

async function detectRunner(root: string): Promise<string> {
  const has = async (f: string) => Boolean(await readFile(path.join(root, f)).catch(() => null));
  if (await has("pnpm-lock.yaml")) return "pnpm";
  if (await has("yarn.lock")) return "yarn";
  if ((await has("bun.lockb")) || (await has("bun.lock"))) return "bun";
  return "npm";
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s"'`<>]*)?/i;
// Colour codes and other terminal escapes don't belong in the Run tab.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

interface Proc {
  child?: ChildProcess;
  state: Omit<ScriptState, "lines" | "total">;
  lines: string[];
  /** Lines dropped from the front (so `total` keeps counting). */
  dropped: number;
  partial: string;
  stopping?: boolean;
}

// Every runner, so one exit hook stops what they all started.
const runners = new Set<ScriptRunner>();
let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const stopAll = () => runners.forEach((r) => r.stopAll());
  process.once("exit", stopAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      stopAll();
      process.exit(0);
    });
}

export class ScriptRunner {
  private procs = new Map<string, Proc>();

  constructor() {
    runners.add(this);
    hookExit();
  }

  private key(project: string, id: string) {
    return `${project}\0${id}`;
  }

  state(project: string, id: string, from = 0): ScriptState {
    const p = this.procs.get(this.key(project, id));
    if (!p) return { id, status: "idle", lines: [], total: 0 };
    const total = p.dropped + p.lines.length;
    const start = Math.max(0, Math.min(from, total) - p.dropped);
    return { ...p.state, lines: p.lines.slice(start), total };
  }

  running(project: string): string[] {
    return [...this.procs.entries()]
      .filter(([k, p]) => k.startsWith(`${project}\0`) && p.state.status === "running")
      .map(([, p]) => p.state.id);
  }

  start(project: string, cwd: string, script: ProjectScript): ScriptState {
    const k = this.key(project, script.id);
    if (this.procs.get(k)?.state.status === "running") throw new HttpError(409, `${script.name} is already running`);
    const proc: Proc = {
      state: { id: script.id, status: "running", startedAt: Date.now() },
      lines: [],
      dropped: 0,
      partial: "",
    };
    this.procs.set(k, proc);
    const push = (text: string) => {
      const parts = (proc.partial + text.replace(ANSI, "").replace(/\r(?!\n)/g, "\n")).split(/\r?\n/);
      proc.partial = parts.pop() ?? "";
      for (const line of parts) this.addLine(proc, line);
    };
    push(`$ ${script.command}\n`);
    const child = spawn(script.command, {
      cwd,
      shell: true,
      windowsHide: true,
      // Its own process group (macOS, Linux), so Stop also ends what it started.
      detached: process.platform !== "win32",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.child = child;
    child.stdout?.on("data", (b: Buffer) => push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => push(b.toString()));
    const end = (code: number | null, err?: Error) => {
      if (proc.state.status !== "running") return;
      if (proc.partial) this.addLine(proc, proc.partial);
      proc.partial = "";
      if (err) this.addLine(proc, `Couldn't start it: ${err.message}`);
      proc.state = {
        ...proc.state,
        status: proc.stopping ? "stopped" : code === 0 && !err ? "done" : "failed",
        exitCode: code,
        endedAt: Date.now(),
      };
      proc.child = undefined;
    };
    child.on("error", (err) => end(null, err));
    child.on("close", (code) => end(code));
    return this.state(project, script.id);
  }

  private addLine(proc: Proc, line: string) {
    proc.lines.push(line.slice(0, 2000));
    if (!proc.state.url) {
      const m = URL_RE.exec(line);
      if (m) proc.state.url = m[0].replace("0.0.0.0", "localhost").replace(/[.,;)]+$/, "");
    }
    if (proc.lines.length > MAX_LINES) {
      const cut = proc.lines.length - MAX_LINES;
      proc.lines.splice(0, cut);
      proc.dropped += cut;
    }
  }

  stop(project: string, id: string): void {
    const p = this.procs.get(this.key(project, id));
    const child = p?.child;
    if (!p || !child?.pid) return;
    p.stopping = true;
    killTree(child.pid);
  }

  /** Clears a finished script's output. */
  clear(project: string, id: string): void {
    const k = this.key(project, id);
    if (this.procs.get(k)?.state.status !== "running") this.procs.delete(k);
  }

  /** On exit: nothing keeps running after MultiCode closes. */
  stopAll(): void {
    for (const p of this.procs.values()) if (p.child?.pid) killTree(p.child.pid);
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
