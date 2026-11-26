// Hooks, as in Claude Code: your commands run on events and get the event as JSON on stdin.
//   UserPromptSubmit  before a request starts. Exit 2 blocks it (stderr says why); anything the
//                     command prints is added to what the crew reads.
//   PostToolUse       after the crew changes a file (matcher: a glob on the path, e.g. "**/*.ts").
//   Notification      when an action waits for your approval.
//   Stop              when a run ends (done, failed or stopped).
import { spawn } from "node:child_process";
import { HttpError } from "./config.js";
import type { Hook, HookEvent } from "./shared.js";

export const HOOK_EVENTS: HookEvent[] = ["UserPromptSubmit", "PostToolUse", "Notification", "Stop"];
const TIMEOUT_MS = 60_000;
const MAX_OUT = 8000;

export function parseHooks(input: unknown): Hook[] {
  if (!Array.isArray(input)) throw new HttpError(400, "hooks must be a list");
  if (input.length > 20) throw new HttpError(400, "at most 20 hooks");
  return input.map((raw, i) => {
    const h = (raw ?? {}) as Record<string, unknown>;
    if (!HOOK_EVENTS.includes(h.event as HookEvent))
      throw new HttpError(400, `hooks[${i}].event must be one of ${HOOK_EVENTS.join(", ")}`);
    const command = typeof h.command === "string" ? h.command.trim() : "";
    if (!command || command.length > 1000 || /[\r\n]/.test(command))
      throw new HttpError(400, `hooks[${i}].command must be one line (1000 characters at most)`);
    const matcher = typeof h.matcher === "string" && h.matcher.trim() ? h.matcher.trim().slice(0, 200) : undefined;
    return { event: h.event as HookEvent, command, ...(matcher ? { matcher } : {}) };
  });
}

export interface HookResult {
  hook: Hook;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runHook(hook: Hook, cwd: string, payload: unknown): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, { cwd, shell: true, windowsHide: true, env: { ...process.env, MULTICODE_HOOK: hook.event } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout = (stdout + b.toString()).slice(-MAX_OUT)));
    child.stderr.on("data", (b: Buffer) => (stderr = (stderr + b.toString()).slice(-MAX_OUT)));
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${TIMEOUT_MS / 1000}s)`;
      child.kill();
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ hook, code: null, stdout, stderr: `Couldn't run it: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ hook, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: hook.event, ...(payload as object) }));
  });
}

/** Does a PostToolUse matcher (a simple glob: * within a folder, ** across folders) take this path? */
export function matches(matcher: string | undefined, file: string): boolean {
  if (!matcher || matcher === "*") return true;
  const re = matcher
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`).test(file);
}
