// Your own "/" commands, as Claude Code and Codex keep them: Markdown files whose body is the prompt.
//   Claude Code: <project>/.claude/commands/**/*.md and ~/.claude/commands/**/*.md
//   Codex:       ~/.codex/prompts/*.md
// An optional front matter "description:" line is shown in the menu; $ARGUMENTS is replaced by
// what you type after the command.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
  source: "project" | "Claude Code" | "Codex";
}

const NAME = /^[a-z0-9][a-z0-9:_-]{0,40}$/;
const MAX_BYTES = 32_000;

async function walk(dir: string, prefix: string, depth: number): Promise<{ file: string; name: string }[]> {
  if (depth > 2) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { file: string; name: string }[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, `${prefix}${e.name}:`, depth + 1)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push({ file: full, name: `${prefix}${e.name.slice(0, -3)}` });
  }
  return out;
}

export function parseCommand(text: string): { description: string; body: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  const desc = fm ? /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]!)?.[1] : undefined;
  return { description: (desc ?? body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "").slice(0, 120), body };
}

export async function listCommands(projectRoot: string | undefined, home = homedir()): Promise<CustomCommand[]> {
  const sources: [CustomCommand["source"], string][] = [
    ...(projectRoot ? ([["project", path.join(projectRoot, ".claude", "commands")]] as [CustomCommand["source"], string][]) : []),
    ["Claude Code", path.join(home, ".claude", "commands")],
    ["Codex", path.join(home, ".codex", "prompts")],
  ];
  const seen = new Set<string>();
  const out: CustomCommand[] = [];
  for (const [source, dir] of sources)
    for (const { file, name } of await walk(dir, "", 0)) {
      const id = name.toLowerCase();
      if (!NAME.test(id) || seen.has(id) || out.length >= 100) continue;
      const s = await stat(file).catch(() => null);
      if (!s || s.size > MAX_BYTES) continue;
      const { description, body } = parseCommand(await readFile(file, "utf8"));
      if (!body) continue;
      seen.add(id);
      out.push({ name: id, description, body, source });
    }
  return out;
}
