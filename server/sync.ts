import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SyncConfig } from "./config.js";
import type { HarnessSyncStatus, McpServer } from "./shared.js";
import { skillMarkdown, type Skill } from "./skills.js";
import type { Workspace } from "./workspace.js";

/**
 * Keeps every harness on the same page. MultiCode owns one marked block in each
 * instruction file and only the MCP entries it created in each config file; everything
 * the user wrote by hand is left alone.
 *
 *   Codex, OpenCode, generic  -> AGENTS.md
 *   Claude Code               -> CLAUDE.md, .mcp.json
 *   Gemini CLI                -> GEMINI.md, .gemini/settings.json
 *   Qwen Code                 -> QWEN.md,   .qwen/settings.json
 *   OpenCode                  -> opencode.json
 *   Codex MCP                 -> passed per call as `-c mcp_servers.*` overrides (no file)
 *
 * Secrets never land in project files: configs reference env vars, and MultiCode injects
 * the values into the agent processes it starts.
 */

const BEGIN = "<!-- multicode:begin -->";
const END = "<!-- multicode:end -->";
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md"];
const MAX_MEMORY = 15;

export interface MemoryEntry {
  at: number;
  prompt: string;
  summary: string;
}

interface SyncState {
  managedServers: string[];
  createdFiles: string[];
  /** Skill folders MultiCode created (relative paths), so it never touches the user's own. */
  managedSkills: string[];
}

/** Where each harness looks for project skills. OpenCode reads .claude/ and .agents/ too. */
const SKILL_DIRS: { dir: string; harness: string }[] = [
  { dir: ".claude/skills", harness: "Claude Code" },
  { dir: ".agents/skills", harness: "Codex" },
  { dir: ".gemini/skills", harness: "Gemini CLI" },
  { dir: ".qwen/skills", harness: "Qwen Code" },
];

/** What plugins and skill packs add on top of the user's own sync settings. */
export interface SyncExtras {
  servers: McpServer[];
  instructions: string[];
  skills: Skill[];
}

export class ProjectMemory {
  constructor(private dir: string) {}

  private file(project: string) {
    return path.join(this.dir, `${project}.json`);
  }

  async read(project: string): Promise<MemoryEntry[]> {
    try {
      const data = JSON.parse(await readFile(this.file(project), "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async add(project: string, entry: MemoryEntry): Promise<void> {
    const all = [...(await this.read(project)), entry].slice(-50);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(project), JSON.stringify(all, null, 1));
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function renderBlock(
  instructions: string,
  memory: MemoryEntry[],
): string {
  const parts: string[] = [];
  if (instructions.trim())
    parts.push(`## Shared instructions\n\n${instructions.trim()}`);
  if (memory.length) {
    const lines = memory
      .slice(-MAX_MEMORY)
      .map(
        (m) =>
          `- ${new Date(m.at).toISOString().slice(0, 10)}: ${oneLine(m.prompt, 140)} → ${oneLine(m.summary, 220)}`,
      );
    parts.push(`## Project memory (recent crew work)\n\n${lines.join("\n")}`);
  }
  if (!parts.length) return "";
  return `${BEGIN}\n<!-- Managed by MultiCode. Edit shared instructions in MultiCode → Sync; changes here are overwritten. -->\n\n${parts.join("\n\n")}\n\n${END}`;
}

/** Replaces (or removes) MultiCode's block, leaving the rest of the file untouched. */
export function upsertBlock(
  existing: string | undefined,
  block: string,
): string | undefined {
  const text = existing ?? "";
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const hasBlock = start >= 0 && end > start;
  let next: string;
  if (hasBlock)
    next = text.slice(0, start) + block + text.slice(end + END.length);
  else if (!block) return existing;
  else
    next = text.trim()
      ? `${text.replace(/\s*$/, "")}\n\n${block}\n`
      : `${block}\n`;
  next = next.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return next ? `${next}\n` : "";
}

const envRef = {
  claude: (n: string) => `\${${n}}`,
  gemini: (n: string) => `$${n}`,
  opencode: (n: string) => `{env:${n}}`,
};

/** Env for a server: fixed values literally, secrets as references. */
const envFor = (s: McpServer, ref: (n: string) => string) =>
  Object.fromEntries(
    (s.envNames ?? []).map((n) => [n, s.fixedEnv?.[n] ?? ref(n)]),
  );

function claudeEntry(s: McpServer) {
  if (s.type === "http") return { type: "http", url: s.url };
  return {
    command: s.command,
    args: s.args ?? [],
    env: envFor(s, envRef.claude),
  };
}
function geminiEntry(s: McpServer) {
  if (s.type === "http") return { httpUrl: s.url };
  return {
    command: s.command,
    args: s.args ?? [],
    env: envFor(s, envRef.gemini),
  };
}
export function opencodeEntry(s: McpServer) {
  if (s.type === "http") return { type: "remote", url: s.url, enabled: true };
  return {
    type: "local",
    command: [s.command!, ...(s.args ?? [])],
    environment: envFor(s, envRef.opencode),
    enabled: true,
  };
}

/** TOML-quoted string. */
const toml = (v: string) => JSON.stringify(v);

/**
 * `-c` overrides that give Codex the shared MCP servers for one call. Env values are not on
 * the command line: `env_vars` tells Codex to forward those variables from its own
 * environment, which MultiCode fills in.
 */
export function codexMcpArgs(servers: McpServer[]): string[] {
  return servers.flatMap((s) => {
    const key = `mcp_servers.${s.name}`;
    if (s.type === "http") return ["-c", `${key}.url=${toml(s.url!)}`];
    const out = [
      "-c",
      `${key}.command=${toml(s.command!)}`,
      "-c",
      `${key}.args=[${(s.args ?? []).map(toml).join(",")}]`,
    ];
    const fixed = Object.entries(s.fixedEnv ?? {});
    const secret = (s.envNames ?? []).filter((n) => !(n in (s.fixedEnv ?? {})));
    if (fixed.length)
      out.push(
        "-c",
        `${key}.env={${fixed.map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`,
      );
    if (secret.length)
      out.push("-c", `${key}.env_vars=[${secret.map(toml).join(",")}]`);
    return out;
  });
}

interface JsonTarget {
  file: string;
  harness: string;
  key: string;
  entry: (s: McpServer) => unknown;
  base?: Record<string, unknown>;
}

const JSON_TARGETS: JsonTarget[] = [
  {
    file: ".mcp.json",
    harness: "Claude Code",
    key: "mcpServers",
    entry: claudeEntry,
  },
  {
    file: ".gemini/settings.json",
    harness: "Gemini CLI",
    key: "mcpServers",
    entry: geminiEntry,
  },
  {
    file: ".qwen/settings.json",
    harness: "Qwen Code",
    key: "mcpServers",
    entry: geminiEntry,
  },
  {
    file: "opencode.json",
    harness: "OpenCode",
    key: "mcp",
    entry: opencodeEntry,
    base: { $schema: "https://opencode.ai/config.json" },
  },
];

export class HarnessSync {
  constructor(
    private stateDir: string,
    private memory: ProjectMemory,
  ) {}

  private stateFile(project: string) {
    return path.join(this.stateDir, `${project}.json`);
  }

  private async state(project: string): Promise<SyncState> {
    try {
      const s = JSON.parse(await readFile(this.stateFile(project), "utf8"));
      return {
        managedServers: s.managedServers ?? [],
        createdFiles: s.createdFiles ?? [],
        managedSkills: s.managedSkills ?? [],
      };
    } catch {
      return { managedServers: [], createdFiles: [], managedSkills: [] };
    }
  }

  /** Writes the shared state into every harness file of the project. */
  async apply(
    project: string,
    ws: Workspace,
    cfg: SyncConfig,
    extras: SyncExtras = { servers: [], instructions: [], skills: [] },
  ): Promise<HarnessSyncStatus[]> {
    const state = await this.state(project);
    const created = new Set(state.createdFiles);
    const instructions = [cfg.instructions.trim(), ...extras.instructions]
      .filter(Boolean)
      .join("\n\n");
    const block = renderBlock(instructions, await this.memory.read(project));
    const servers = [
      ...cfg.mcpServers,
      ...extras.servers.filter(
        (p) => !cfg.mcpServers.some((u) => u.name === p.name),
      ),
    ];
    const status = new Map<string, Set<string>>();
    const touch = (harness: string, file: string) =>
      status.set(harness, (status.get(harness) ?? new Set()).add(file));

    for (const file of INSTRUCTION_FILES) {
      const before = await ws.tryRead(file);
      const next = upsertBlock(before, block);
      if (next === before) continue;
      if (next === "" && created.has(file)) {
        await ws.remove(file);
        created.delete(file);
      } else if (next !== undefined) {
        if (before === undefined) created.add(file);
        await ws.write(file, next);
      }
    }
    if (block) {
      touch("Codex", "AGENTS.md");
      touch("OpenCode", "AGENTS.md");
      touch("Claude Code", "CLAUDE.md");
      touch("Gemini CLI", "GEMINI.md");
      touch("Qwen Code", "QWEN.md");
    }

    const names = servers.map((s) => s.name);
    for (const t of JSON_TARGETS) {
      const raw = await ws.tryRead(t.file);
      let doc: Record<string, unknown>;
      try {
        doc = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (typeof doc !== "object" || doc === null || Array.isArray(doc))
          throw new Error("not an object");
      } catch {
        status.set(
          t.harness,
          new Set([`${t.file} (not updated: it isn't valid JSON)`]),
        );
        continue;
      }
      const section = { ...((doc[t.key] as Record<string, unknown>) ?? {}) };
      for (const old of state.managedServers)
        if (!names.includes(old)) delete section[old];
      for (const s of servers) section[s.name] = t.entry(s);
      const next: Record<string, unknown> = {
        ...(raw ? {} : (t.base ?? {})),
        ...doc,
      };
      if (Object.keys(section).length) next[t.key] = section;
      else delete next[t.key];

      const onlyBase = Object.keys(next).every((k) => k in (t.base ?? {}));
      if (onlyBase && created.has(t.file)) {
        await rm(ws.abs(t.file), { force: true });
        created.delete(t.file);
        continue;
      }
      if (!raw && !servers.length) continue;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      if (text !== raw) {
        if (!raw) created.add(t.file);
        await ws.write(t.file, text);
      }
      if (servers.length) touch(t.harness, t.file);
    }
    if (servers.length) touch("Codex", "MCP passed per run (-c mcp_servers.*)");

    // Skills: one folder per skill in every harness's skills directory.
    const wanted = new Set<string>();
    const userOwned: string[] = [];
    for (const { dir, harness } of SKILL_DIRS) {
      for (const skill of extras.skills) {
        const rel = `${dir}/${skill.name}`;
        const file = `${rel}/SKILL.md`;
        const existing = await ws.tryRead(file);
        if (existing !== undefined && !state.managedSkills.includes(rel)) {
          userOwned.push(file); // the user's own skill with that name wins
          continue;
        }
        wanted.add(rel);
        const text = skillMarkdown(skill);
        if (existing !== text) await ws.write(file, text);
        touch(harness, `${dir}/ (${extras.skills.length} skills)`);
      }
    }
    if (extras.skills.length)
      touch("OpenCode", ".claude/skills + .agents/skills");
    for (const rel of state.managedSkills)
      if (!wanted.has(rel))
        await rm(ws.abs(rel), { recursive: true, force: true });

    await mkdir(this.stateDir, { recursive: true });
    await writeFile(
      this.stateFile(project),
      JSON.stringify({
        managedServers: names,
        createdFiles: [...created],
        managedSkills: [...wanted],
      }),
    );
    return [...status.entries()].map(([harness, files]) => ({
      harness,
      files: [...files],
      ...(userOwned.length && harness === "Claude Code"
        ? { note: `Kept your own: ${userOwned.join(", ")}` }
        : {}),
    }));
  }
}
