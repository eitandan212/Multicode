// "Connect everything": MCP servers you already set up in other tools (Claude Code, Claude Desktop,
// Codex, Cursor, Gemini CLI, Windsurf) can be brought into MultiCode with one click. Their secret
// values stay on this computer: the UI only ever sees names.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { McpServer } from "./shared.js";

export interface FoundServer {
  source: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Values found in the source config (kept server-side). */
  env: Record<string, string>;
}

export interface FoundServerView extends Omit<FoundServer, "env"> {
  envNames: string[];
  /** Already among MultiCode's shared servers (same name). */
  added: boolean;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** One server entry in the common JSON shape ({command, args, env} or {url | httpUrl | serverUrl}). */
export function fromEntry(source: string, rawName: string, raw: unknown): FoundServer | undefined {
  const e = (raw ?? {}) as Record<string, unknown>;
  const name = rawName.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
  if (!NAME.test(name) || e.disabled === true || e.enabled === false) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((e.env ?? {}) as Record<string, unknown>))
    if (ENV.test(k) && typeof v === "string" && v.length <= 4000) env[k] = v;
  const url = [e.url, e.httpUrl, e.serverUrl].find((u): u is string => typeof u === "string");
  if (url && /^https?:\/\//i.test(url)) return { source, name, type: "http", url, env };
  if (typeof e.command !== "string" || !e.command.trim()) return undefined;
  const args = Array.isArray(e.args) ? e.args.map(String).slice(0, 40) : [];
  return { source, name, type: "stdio", command: e.command.trim(), args, env };
}

function fromMap(source: string, map: unknown): FoundServer[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map as Record<string, unknown>).flatMap(([n, v]) => fromEntry(source, n, v) ?? []);
}

/** Every MCP server configured in the tools found on this computer. */
export async function discoverMcp(home = homedir(), platform = process.platform): Promise<FoundServer[]> {
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const desktop =
    platform === "win32"
      ? path.join(appData, "Claude", "claude_desktop_config.json")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const out: FoundServer[] = [];

  const claude = (await readJson(path.join(home, ".claude.json"))) as
    | { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }
    | undefined;
  out.push(...fromMap("Claude Code", claude?.mcpServers));
  for (const p of Object.values(claude?.projects ?? {})) out.push(...fromMap("Claude Code", p?.mcpServers));

  out.push(...fromMap("Claude Desktop", ((await readJson(desktop)) as { mcpServers?: unknown })?.mcpServers));
  out.push(...fromMap("Cursor", ((await readJson(path.join(home, ".cursor", "mcp.json"))) as { mcpServers?: unknown })?.mcpServers));
  out.push(...fromMap("Gemini CLI", ((await readJson(path.join(home, ".gemini", "settings.json"))) as { mcpServers?: unknown })?.mcpServers));
  out.push(
    ...fromMap(
      "Windsurf",
      ((await readJson(path.join(home, ".codeium", "windsurf", "mcp_config.json"))) as { mcpServers?: unknown })?.mcpServers,
    ),
  );

  // Codex keeps them in TOML: [mcp_servers.<name>] command / args / env / url.
  try {
    const toml = parseToml(await readFile(path.join(home, ".codex", "config.toml"), "utf8")) as {
      mcp_servers?: Record<string, unknown>;
    };
    out.push(...fromMap("Codex", toml.mcp_servers));
  } catch {
    /* no Codex, or a config it can't read */
  }

  // The same server set up in several tools is offered once (the first source wins).
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.name}|${s.command ?? s.url}|${(s.args ?? []).join(" ")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function viewOf(found: FoundServer[], existing: McpServer[]): FoundServerView[] {
  const names = new Set(existing.map((s) => s.name));
  return found.map(({ env, ...s }) => ({ ...s, envNames: Object.keys(env), added: names.has(s.name) }));
}

/** What to send to setSync to add the chosen servers (and their secret values) to MultiCode. */
export function importPlan(
  found: FoundServer[],
  picks: { source: string; name: string }[],
  existing: McpServer[],
): { mcpServers: McpServer[]; env: Record<string, string> } {
  const names = new Set(existing.map((s) => s.name));
  const added: McpServer[] = [];
  const env: Record<string, string> = {};
  for (const pick of picks) {
    const s = found.find((f) => f.source === pick.source && f.name === pick.name);
    if (!s || names.has(s.name)) continue;
    names.add(s.name);
    added.push(
      s.type === "http"
        ? { name: s.name, type: "http", url: s.url!, envNames: Object.keys(s.env) }
        : { name: s.name, type: "stdio", command: s.command!, args: s.args ?? [], envNames: Object.keys(s.env) },
    );
    Object.assign(env, s.env);
  }
  return { mcpServers: [...existing, ...added], env };
}
