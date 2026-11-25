// Version control for a project folder, as Codex and Claude Code offer it: see what changed,
// commit it, push it. Runs the user's own git; nothing here rewrites history.
import { execFile } from "node:child_process";
import { HttpError } from "./config.js";
import type { GitStatus } from "./shared.js";

export type { GitStatus } from "./shared.js";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeout = 20_000): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // Never wait for a password prompt nobody can see.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        // Exit status, 127 when git itself is missing.
        const raw = (err as { code?: number | string } | null)?.code;
        const code = !err ? 0 : raw === "ENOENT" ? 127 : typeof raw === "number" ? raw : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Pictures pasted into the message box stay out of commits. */
const BASE_SPEC = ["--", ".", ":(exclude).attachments"];

/**
 * What MultiCode's sync writes for each harness (skills and MCP configs with this computer's
 * paths). It stays out of commits unless you already track it yourself.
 */
export const GENERATED = [
  ".mcp.json",
  ".gemini/settings.json",
  ".qwen/settings.json",
  "opencode.json",
  ".claude/skills",
  ".agents/skills",
  ".gemini/skills",
  ".qwen/skills",
];

async function pathspec(root: string): Promise<string[]> {
  const tracked = await git(root, ["ls-files", "--", ...GENERATED]);
  const mine = new Set(tracked.stdout.split("\n").filter(Boolean));
  const skip = GENERATED.filter((g) => ![...mine].some((t) => t === g || t.startsWith(`${g}/`)));
  return [...BASE_SPEC, ...skip.map((g) => `:(exclude)${g}`)];
}

const STATE: Record<string, GitStatus["files"][number]["status"]> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
  "?": "added",
  U: "conflict",
};

export async function gitStatus(root: string): Promise<GitStatus> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top.code === 127) return { repo: false, installed: false, files: [] };
  if (top.code !== 0) return { repo: false, installed: true, files: [] };
  const st = await git(root, ["status", "--porcelain=v1", "--branch", "--untracked-files=all", ...(await pathspec(root))]);
  if (st.code !== 0) throw new HttpError(500, st.stderr.trim() || "git status failed");
  const lines = st.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  // "main...origin/main [ahead 1, behind 2]" or "No commits yet on main" or "HEAD (no branch)"
  const branch = head.startsWith("No commits yet on ")
    ? head.slice("No commits yet on ".length)
    : head.split("...")[0]!.split(" ")[0]!;
  const upstream = head.includes("...") ? head.split("...")[1]!.split(" ")[0] : undefined;
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  const files = lines.slice(0, 300).map((l) => {
    const xy = l.slice(0, 2);
    const raw = l.slice(3);
    const file = raw.includes(" -> ") ? raw.split(" -> ")[1]! : raw;
    const code = (xy.trim()[0] ?? "M") as keyof typeof STATE;
    return { path: file.replace(/^"|"$/g, ""), status: xy.includes("U") ? "conflict" : (STATE[code] ?? "modified") };
  });
  return {
    repo: true,
    installed: true,
    branch: branch || "HEAD",
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    files,
  };
}

export async function gitInit(root: string): Promise<GitStatus> {
  const r = await git(root, ["init"]);
  if (r.code === 127) throw new HttpError(400, "Git isn't installed on this computer. Get it from git-scm.com.");
  if (r.code !== 0) throw new HttpError(500, r.stderr.trim() || "git init failed");
  return gitStatus(root);
}

export async function gitCommit(root: string, message: unknown): Promise<GitStatus> {
  if (typeof message !== "string" || !message.trim()) throw new HttpError(400, "write a commit message");
  if (message.length > 5000) throw new HttpError(400, "the commit message is too long");
  const add = await git(root, ["add", "-A", ...(await pathspec(root))]);
  if (add.code !== 0) throw new HttpError(500, add.stderr.trim() || "git add failed");
  const c = await git(root, ["commit", "-m", message.trim()]);
  if (c.code !== 0) {
    const why = `${c.stdout}\n${c.stderr}`;
    if (/Please tell me who you are|user\.email|user\.name/i.test(why))
      throw new HttpError(
        400,
        'Git needs your name and email first. Run: git config --global user.name "Your Name" and git config --global user.email you@example.com',
      );
    if (/nothing (added )?to commit/i.test(why)) throw new HttpError(400, "Nothing to commit: no changes.");
    throw new HttpError(500, why.trim().split("\n").slice(-3).join(" ") || "git commit failed");
  }
  return gitStatus(root);
}

export async function gitPush(root: string): Promise<GitStatus> {
  const s = await gitStatus(root);
  if (!s.repo) throw new HttpError(400, "This project isn't under version control.");
  const args = s.upstream ? ["push"] : ["push", "--set-upstream", "origin", s.branch ?? "HEAD"];
  const r = await git(root, args, 90_000);
  if (r.code !== 0) {
    const why = r.stderr.trim();
    if (/does not appear to be a git repository|No configured push destination|'origin'/i.test(why))
      throw new HttpError(400, "There's no remote to push to. Add one with: git remote add origin <url>");
    if (/Authentication failed|could not read Username|Permission denied|403/i.test(why))
      throw new HttpError(400, "Git couldn't sign in to the remote. Sign in once in a terminal (git push), then try again.");
    if (/rejected|non-fast-forward|fetch first/i.test(why))
      throw new HttpError(409, "The remote has newer commits. Pull them first (git pull), then push.");
    throw new HttpError(500, why.split("\n").slice(-2).join(" ") || "git push failed");
  }
  return gitStatus(root);
}
