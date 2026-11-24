import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Minimal glob: `*` within a segment, `**` across segments, `?` one char. Matched on the path or its basename. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** True when a project-relative path is protected (never read, written or applied). */
export function makeProtector(patterns: string[]): (rel: string) => boolean {
  const res = patterns.map(globToRegExp);
  return (rel) => {
    const norm = rel.replace(/\\/g, "/");
    const base = norm.split("/").pop()!;
    return res.some((r) => r.test(norm) || r.test(base));
  };
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", ".cache"]);
const MAX_SANDBOX_BYTES = 300_000_000;

/**
 * Copies a project into a sandbox folder. Protected files and heavy folders are left out,
 * so agents in the sandbox can't read secrets and nothing they do reaches the real project.
 */
export async function copyToSandbox(src: string, dest: string, isProtected: (rel: string) => boolean): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  let bytes = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await mkdir(path.join(dest, r), { recursive: true });
        await walk(path.join(dir, e.name), r);
      } else if (e.isFile() && !isProtected(r)) {
        bytes += (await stat(path.join(dir, e.name))).size;
        if (bytes > MAX_SANDBOX_BYTES) throw new Error("This project is too large to copy into a sandbox (over 300 MB without node_modules).");
        await cp(path.join(dir, e.name), path.join(dest, r));
      }
    }
  };
  await walk(src, "");
}
