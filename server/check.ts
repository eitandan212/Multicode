// A project's check command (e.g. "npm test"), run after the crew builds, like a Claude Code hook
// on edits: its result goes to the reviewer, and a failure becomes a fix task.
import { spawn } from "node:child_process";

export interface CheckResult {
  ok: boolean;
  /** The end of the combined output (what explains a failure). */
  output: string;
  ms: number;
}

const MAX_OUTPUT = 6000;

export function runCheck(cwd: string, command: string, signal?: AbortSignal, timeoutMs = 5 * 60_000): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let out = "";
    const keep = (b: Buffer) => {
      out = (out + b.toString()).slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let why = "";
    const stop = (reason: string) => {
      why = reason;
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 60_000)} min`), timeoutMs);
    const onAbort = () => stop("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null, err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const tail = out.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-MAX_OUTPUT);
      resolve({
        ok: !err && !why && code === 0,
        output: [err ? `Couldn't run it: ${err.message}` : "", why ? `(${why})` : "", tail].filter(Boolean).join("\n"),
        ms: Date.now() - started,
      });
    };
    child.on("error", (err) => done(null, err));
    child.on("close", (code) => done(code));
  });
}
