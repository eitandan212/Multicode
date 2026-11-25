import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./config.js";
import type { ProjectInfo } from "./shared.js";

// Harness folders (skills, settings) are managed by MultiCode's sync; keep them out of
// file listings, snapshots and prompts.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
  ".cache",
  ".claude",
  ".agents",
  ".gemini",
  ".qwen",
  ".opencode",
  ".playwright-mcp",
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 2000;
const PROJECT_NAME = /^[a-z0-9][a-z0-9-_]{0,47}$/i;

export function validateProjectName(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_NAME.test(name))
    throw new HttpError(
      400,
      "project name must be 1-48 letters, digits, '-' or '_'",
    );
  return name;
}

/** Normalises a model-supplied relative path and rejects anything escaping the root. */
export function safeRelative(p: string): string {
  if (typeof p !== "string" || !p.trim())
    throw new HttpError(400, "empty path");
  const cleaned = p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  if (cleaned.startsWith("/") || /^[a-z]:/i.test(cleaned))
    throw new HttpError(400, `absolute path not allowed: ${p}`);
  const norm = path.posix.normalize(cleaned);
  if (norm === "." || norm.startsWith("../") || norm === "..")
    throw new HttpError(400, `path escapes project: ${p}`);
  const parts = norm.split("/");
  if (parts.some((s) => s === ".git" || s === "node_modules"))
    throw new HttpError(400, `protected path: ${p}`);
  if (norm.includes("\0")) throw new HttpError(400, "invalid path");
  return norm;
}

export interface FileSnapshot {
  [rel: string]: string; // "mtimeMs:size"
}

export class Workspace {
  constructor(public readonly root: string) {}

  static async open(projectsDir: string, name: string): Promise<Workspace> {
    const root = path.join(projectsDir, validateProjectName(name));
    await mkdir(root, { recursive: true });
    return new Workspace(root);
  }

  abs(rel: string): string {
    const full = path.resolve(this.root, safeRelative(rel));
    if (!full.startsWith(this.root + path.sep))
      throw new HttpError(400, `path escapes project: ${rel}`);
    return full;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name))
            await walk(path.join(dir, e.name), rel);
        } else if (e.isFile()) out.push(rel);
      }
    };
    await walk(this.root, "");
    return out;
  }

  async read(rel: string): Promise<string> {
    const full = this.abs(rel);
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) throw new HttpError(404, `file not found: ${rel}`);
    if (s.size > MAX_FILE_BYTES)
      throw new HttpError(413, `file too large: ${rel}`);
    return readFile(full, "utf8");
  }

  async tryRead(rel: string): Promise<string | undefined> {
    try {
      return await this.read(rel);
    } catch {
      return undefined;
    }
  }

  async write(rel: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw new HttpError(413, `file too large: ${rel}`);
    const full = this.abs(rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }

  async snapshot(): Promise<FileSnapshot> {
    const snap: FileSnapshot = {};
    for (const rel of await this.list()) {
      const s = await stat(path.join(this.root, rel)).catch(() => null);
      if (s) snap[rel] = `${s.mtimeMs}:${s.size}`;
    }
    return snap;
  }

  static diff(
    before: FileSnapshot,
    after: FileSnapshot,
  ): { path: string; change: "write" | "delete" }[] {
    const changes: { path: string; change: "write" | "delete" }[] = [];
    for (const [p, sig] of Object.entries(after))
      if (before[p] !== sig) changes.push({ path: p, change: "write" });
    for (const p of Object.keys(before))
      if (!(p in after)) changes.push({ path: p, change: "delete" });
    return changes;
  }

  /** A compact, size-bounded view of the project for prompts. */
  async contextDigest(
    maxChars = 60_000,
    focus: string[] = [],
    exclude?: (rel: string) => boolean,
    /** Cap for files outside `focus` (they only give context; the focus files are the work). */
    othersMax = Infinity,
  ): Promise<{ tree: string; files: string }> {
    const all = (await this.list()).filter((f) => !exclude?.(f));
    const tree = all.join("\n") || "(empty project)";
    const ordered = [
      ...new Set([...focus.filter((f) => all.includes(f)), ...all]),
    ];
    let budget = maxChars;
    let others = othersMax;
    const parts: string[] = [];
    for (const rel of ordered) {
      if (budget <= 0) break;
      const isFocus = focus.includes(rel);
      if (!isFocus && others <= 0) break;
      if (
        /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|mp4|zip|pdf|lock)$/i.test(
          rel,
        )
      )
        continue;
      const text = await this.tryRead(rel);
      if (text === undefined || text.includes("\0")) continue;
      if (text.length > budget && !isFocus) continue;
      if (!isFocus && text.length > others) continue;
      const body =
        text.length > budget ? `${text.slice(0, budget)}\n…(truncated)` : text;
      parts.push(`<file path="${rel}">\n${body}\n</file>`);
      budget -= body.length;
      if (!isFocus) others -= body.length;
    }
    return { tree, files: parts.join("\n\n") };
  }
}

export async function listProjects(
  projectsDir: string,
): Promise<ProjectInfo[]> {
  await mkdir(projectsDir, { recursive: true });
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const out: ProjectInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !PROJECT_NAME.test(e.name)) continue;
    const ws = new Workspace(path.join(projectsDir, e.name));
    const files = await ws.list();
    const s = await stat(ws.root);
    out.push({ name: e.name, fileCount: files.length, updatedAt: s.mtimeMs });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
