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
  const remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
  const gh = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  return {
    repo: true,
    installed: true,
    ...(gh ? { github: `${gh[1]}/${gh[2]}` } : {}),
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

/**
 * What changed since the last commit, as a diff (new files in full), for a review. Undefined when
 * the folder isn't a repository; "" when nothing changed.
 */
export async function gitDiff(root: string, max = 40_000): Promise<string | undefined> {
  const s = await gitStatus(root);
  if (!s.repo) return undefined;
  const spec = await pathspec(root);
  const hasHead = (await git(root, ["rev-parse", "--verify", "HEAD"])).code === 0;
  const tracked = hasHead ? (await git(root, ["diff", "HEAD", "--no-color", "-U3", ...spec], 30_000)).stdout : "";
  let out = tracked;
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", ...spec])).stdout
    .split("\n")
    .filter(Boolean);
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  for (const f of untracked) {
    if (out.length >= max) break;
    const text = await readFile(path.join(root, f), "utf8").catch(() => undefined);
    if (text === undefined || text.includes("\u0000")) continue;
    out += `\n--- /dev/null\n+++ b/${f} (new file)\n${text.slice(0, 8000).split("\n").map((l) => `+${l}`).join("\n")}\n`;
  }
  return out.length > max ? `${out.slice(0, max)}\n…(diff trimmed)` : out;
}

// ---- GitHub (or any git host): clone a repository, branches, pull, pull requests ----

/** "owner/repo", an https URL or git@host:owner/repo → a clone URL. Never an option or a local path. */
export function cloneUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw.replace(/\.git$/, "")}.git`;
  if (/^https:\/\/[\w.-]+(:\d+)?\/[\w.~/-]+$/.test(raw.replace(/\/$/, ""))) return raw.replace(/\/$/, "");
  if (/^git@[\w.-]+:[\w.~/-]+$/.test(raw)) return raw;
  throw new HttpError(400, "Paste a repository address like github.com/owner/repo or owner/repo");
}

/** A project name from the repository's name. */
export function repoName(url: string): string {
  const last = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return last.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
}

/** Clones into <dir> (a fresh folder). Uses your own git sign-in for private repositories. */
export async function gitClone(dir: string, url: string): Promise<void> {
  const parent = (await import("node:path")).dirname(dir);
  const r = await git(parent, ["clone", "--filter=blob:none", "--", url, dir], 10 * 60_000);
  if (r.code === 127) throw new HttpError(400, "Git isn't installed on this computer. Get it from git-scm.com.");
  if (r.code !== 0) {
    const why = r.stderr.trim();
    if (/not found|Repository not found|could not read Username|Authentication failed|403|terminal prompts disabled/i.test(why))
      throw new HttpError(400, "Couldn't open that repository. Check the address; for a private one, sign in to GitHub once in a terminal (git or gh auth login), then try again.");
    if (/Could not resolve host|unable to access/i.test(why)) throw new HttpError(400, "Couldn't reach the repository. Check the internet connection and the address.");
    throw new HttpError(500, why.split("\n").slice(-2).join(" ") || "git clone failed");
  }
}

export async function gitBranches(root: string): Promise<{ current: string; branches: string[]; defaultBranch?: string }> {
  const s = await gitStatus(root);
  if (!s.repo) throw new HttpError(400, "This project isn't under version control.");
  const local = (await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split("\n").filter(Boolean);
  const head = (await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "");
  return { current: s.branch ?? "", branches: local, ...(head ? { defaultBranch: head } : {}) };
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]{1,100}(?<![./])$/;

/** Switches to a branch, creating it from the current one when asked. Your uncommitted changes come along. */
export async function gitCheckout(root: string, branch: unknown, create: boolean): Promise<GitStatus> {
  if (typeof branch !== "string" || !BRANCH.test(branch)) throw new HttpError(400, "Branch names use letters, digits, -, _, / and .");
  const r = await git(root, create ? ["switch", "-c", branch] : ["switch", branch]);
  if (r.code !== 0) {
    const why = r.stderr.trim();
    if (/already exists/i.test(why)) throw new HttpError(409, `A branch named ${branch} already exists.`);
    if (/would be overwritten/i.test(why)) throw new HttpError(409, "Commit your changes first: switching would overwrite them.");
    throw new HttpError(500, why.split("\n").slice(-2).join(" ") || "git switch failed");
  }
  return gitStatus(root);
}

/** Brings in new commits from the remote (fast-forward only: never a surprise merge). */
export async function gitPull(root: string): Promise<GitStatus> {
  const r = await git(root, ["pull", "--ff-only"], 2 * 60_000);
  if (r.code !== 0) {
    const why = r.stderr.trim();
    if (/Not possible to fast-forward|diverged/i.test(why))
      throw new HttpError(409, "Your branch and the remote both have new commits. Merge them in a terminal (git pull), then continue.");
    if (/no tracking information/i.test(why)) throw new HttpError(400, "This branch isn't on the remote yet: push it first.");
    if (/would be overwritten/i.test(why)) throw new HttpError(409, "Commit your changes first: the pull would overwrite them.");
    throw new HttpError(500, why.split("\n").slice(-2).join(" ") || "git pull failed");
  }
  return gitStatus(root);
}
