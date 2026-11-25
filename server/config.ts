import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  API_KINDS,
  KIND_LABELS,
  connectionName,
  type ConnectionView,
  type CrewMember,
  type DispatchMode,
  type SafetyMode,
  type McpServer,
  type ProviderKind,
  type Role,
  type Settings,
  type SkillMode,
  type SyncConfigView,
} from "./shared.js";
import { PLUGINS } from "./plugins.js";
import { SKILL_PACKS } from "./skills.js";

export interface Connection {
  id: string;
  kind: ProviderKind;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  /** ACP connections: a registry agent, or a custom command the user typed. */
  acp?: AcpRef;
}

export interface AcpRef {
  agentId: string;
  agentName: string;
  icon?: string;
  /** Custom agents only. Registry agents are resolved from the registry at run time. */
  command?: string;
  args?: string[];
}

export interface SyncConfig {
  instructions: string;
  mcpServers: McpServer[];
  /** Secret values for the MCP servers' env vars. Never written into project files. */
  env: Record<string, string>;
}

export interface ExtensionsConfig {
  /** Opt-in plugins the user turned on. */
  pluginsEnabled: string[];
  /** Default-on plugins the user turned off. */
  pluginsDisabled: string[];
  packModes: Record<string, SkillMode>;
  browserAnyWebsite: boolean;
}

export interface ConfigData {
  connections: Connection[];
  crew: CrewMember[];
  settings: Settings;
  sync: SyncConfig;
  extensions: ExtensionsConfig;
}

const ALL_KINDS = Object.keys(KIND_LABELS) as ProviderKind[];
const ROLES: Role[] = ["architect", "builder", "reviewer"];

export function dataDir(): string {
  return process.env.MULTICODE_HOME ?? path.join(homedir(), ".multicode");
}

function emptyConfig(): ConfigData {
  return {
    connections: [],
    crew: [],
    settings: {
      maxReviewRounds: 2,
      dispatch: "smart",
      safety: "direct",
      protectedPaths: DEFAULT_PROTECTED,
      economy: false,
      freeFallback: { enabled: true, model: "opencode/big-pickle" },
      manager: { mode: "auto" },
    },
    sync: { instructions: "", mcpServers: [], env: {} },
    extensions: {
      pluginsEnabled: [],
      pluginsDisabled: [],
      packModes: {},
      browserAnyWebsite: false,
    },
  };
}

export const DEFAULT_PROTECTED = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "**/id_rsa*",
  "**/*.p12",
  ".ssh/**",
  "secrets/**",
];

const MCP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function str(
  v: unknown,
  field: string,
  max = 500,
  required = false,
): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string")
    throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} is too long`);
  return t || undefined;
}

/** Persistent, file-backed configuration. Writes are atomic and the file is chmod 600. */
export class ConfigStore {
  private data: ConfigData = emptyConfig();
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir = dataDir()) {
    this.file = path.join(dir, "config.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(this.file, "utf8"),
      ) as Partial<ConfigData>;
      this.data = {
        connections: Array.isArray(raw.connections) ? raw.connections : [],
        crew: Array.isArray(raw.crew) ? raw.crew : [],
        settings: { ...emptyConfig().settings, ...(raw.settings ?? {}) },
        sync: { ...emptyConfig().sync, ...(raw.sync ?? {}) },
        extensions: { ...emptyConfig().extensions, ...(raw.extensions ?? {}) },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = emptyConfig();
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    });
    return this.writing;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get crew(): CrewMember[] {
    return this.data.crew;
  }

  get connections(): Connection[] {
    return this.data.connections;
  }

  connection(id: string): Connection | undefined {
    return this.data.connections.find((c) => c.id === id);
  }

  views(): ConnectionView[] {
    return this.data.connections.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      baseUrl: c.baseUrl,
      defaultModel: c.defaultModel,
      acp: c.acp
        ? {
            agentId: c.acp.agentId,
            agentName: c.acp.agentName,
            icon: c.acp.icon,
            custom: Boolean(c.acp.command),
          }
        : undefined,
      hasKey: Boolean(c.apiKey),
      keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : undefined,
    }));
  }

  async upsertConnection(
    input: Record<string, unknown>,
    id?: string,
  ): Promise<Connection> {
    const existing = id ? this.connection(id) : undefined;
    if (id && !existing) throw new HttpError(404, "connection not found");
    const kind = (existing?.kind ?? input.kind) as ProviderKind;
    if (!ALL_KINDS.includes(kind))
      throw new HttpError(400, "unknown provider kind");

    const apiKey = str(input.apiKey, "apiKey", 4000);
    const acp =
      kind === "acp"
        ? input.acp === undefined
          ? existing?.acp
          : parseAcpRef(input.acp)
        : undefined;
    if (kind === "acp" && !acp)
      throw new HttpError(400, "acp agent is required");
    const next: Connection = {
      id: existing?.id ?? randomUUID(),
      kind,
      label:
        str(input.label, "label", 80) ??
        existing?.label ??
        acp?.agentName ??
        connectionName(
          kind,
          str(input.baseUrl, "baseUrl", 500),
          str(input.defaultModel, "defaultModel", 200),
        ),
      apiKey: apiKey ?? existing?.apiKey,
      baseUrl:
        input.baseUrl === undefined
          ? existing?.baseUrl
          : str(input.baseUrl, "baseUrl", 500),
      defaultModel:
        input.defaultModel === undefined
          ? existing?.defaultModel
          : str(input.defaultModel, "defaultModel", 200),
      acp,
    };
    if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl))
      throw new HttpError(400, "baseUrl must be http(s)");
    if (kind === "openai-compatible" && !next.baseUrl)
      throw new HttpError(400, "baseUrl is required");
    if (
      API_KINDS.includes(kind) &&
      kind !== "openai-compatible" &&
      !next.apiKey
    )
      throw new HttpError(400, "apiKey is required");

    if (existing) Object.assign(existing, next);
    else this.data.connections.push(next);
    await this.save();
    return existing ?? next;
  }

  async deleteConnection(id: string): Promise<void> {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    if (this.data.connections.length === before)
      throw new HttpError(404, "connection not found");
    this.data.crew = this.data.crew.filter((m) => m.connectionId !== id);
    await this.save();
  }

  async setCrew(input: unknown): Promise<CrewMember[]> {
    if (!Array.isArray(input) || input.length > 20)
      throw new HttpError(400, "crew must be an array (max 20)");
    const crew = input.map((raw, i): CrewMember => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const role = m.role as Role;
      if (!ROLES.includes(role))
        throw new HttpError(400, `crew[${i}].role is invalid`);
      const connectionId = str(
        m.connectionId,
        `crew[${i}].connectionId`,
        100,
        true,
      )!;
      if (!this.connection(connectionId))
        throw new HttpError(400, `crew[${i}] uses an unknown connection`);
      const agents =
        m.agents === undefined || m.agents === null ? 1 : Number(m.agents);
      if (!Number.isInteger(agents) || agents < 1 || agents > 4)
        throw new HttpError(400, `crew[${i}].agents must be 1-4`);
      return {
        id: str(m.id, "id", 100) ?? randomUUID(),
        name: str(m.name, `crew[${i}].name`, 40) ?? `Agent ${i + 1}`,
        role,
        connectionId,
        model: str(m.model, `crew[${i}].model`, 200),
        agents,
        instructions: str(m.instructions, `crew[${i}].instructions`, 1000),
      };
    });
    this.data.crew = crew;
    await this.save();
    return crew;
  }

  async setSettings(input: Record<string, unknown>): Promise<Settings> {
    const next = { ...this.data.settings };
    if (input.maxReviewRounds !== undefined) {
      const rounds = Number(input.maxReviewRounds);
      if (!Number.isInteger(rounds) || rounds < 0 || rounds > 5)
        throw new HttpError(400, "maxReviewRounds must be an integer 0-5");
      next.maxReviewRounds = rounds;
    }
    if (input.safety !== undefined) {
      if (!["direct", "sandbox", "readonly"].includes(String(input.safety)))
        throw new HttpError(400, "safety must be direct, sandbox or readonly");
      next.safety = input.safety as SafetyMode;
    }
    if (input.economy !== undefined) next.economy = input.economy === true;
    if (input.protectedPaths !== undefined) {
      if (
        !Array.isArray(input.protectedPaths) ||
        input.protectedPaths.length > 50
      )
        throw new HttpError(400, "protectedPaths must be a list (max 50)");
      next.protectedPaths = input.protectedPaths
        .map((p) => String(p).trim())
        .filter((p) => p && p.length <= 200 && !p.includes(".."));
    }
    if (input.freeFallback !== undefined) {
      const f = (input.freeFallback ?? {}) as {
        enabled?: unknown;
        model?: unknown;
      };
      const model =
        str(f.model, "freeFallback.model", 200) ?? next.freeFallback.model;
      next.freeFallback = { enabled: f.enabled !== false, model };
    }
    if (input.manager !== undefined) {
      const m = (input.manager ?? {}) as Record<string, unknown>;
      if (!["auto", "pick", "off"].includes(String(m.mode)))
        throw new HttpError(400, "manager.mode must be auto, pick or off");
      if (m.mode === "pick") {
        const connectionId = str(
          m.connectionId,
          "manager.connectionId",
          100,
          true,
        )!;
        if (!this.connection(connectionId))
          throw new HttpError(400, "manager.connectionId is unknown");
        next.manager = {
          mode: "pick",
          connectionId,
          model: str(m.model, "manager.model", 200),
        };
      } else next.manager = { mode: m.mode as "auto" | "off" };
    }
    if (input.dispatch !== undefined) {
      if (input.dispatch !== "smart" && input.dispatch !== "balanced")
        throw new HttpError(400, "dispatch must be smart or balanced");
      next.dispatch = input.dispatch as DispatchMode;
    }
    this.data.settings = next;
    await this.save();
    return next;
  }

  get extensions(): ExtensionsConfig {
    return this.data.extensions;
  }

  /** Turn plugins on/off, set skill-pack modes. High-risk plugins need `confirmRisk: true`. */
  async setExtensions(
    input: Record<string, unknown>,
  ): Promise<ExtensionsConfig> {
    const ext = structuredClone(this.data.extensions);
    if (input.plugin && typeof input.plugin === "object") {
      const { id, enabled, confirmRisk } = input.plugin as {
        id?: unknown;
        enabled?: unknown;
        confirmRisk?: unknown;
      };
      const def = PLUGINS.find((p) => p.id === id);
      if (!def) throw new HttpError(400, "unknown plugin");
      if (enabled === true && def.risk === "high" && confirmRisk !== true)
        throw new HttpError(
          400,
          `${def.name} can control this computer. Confirm the risk to turn it on.`,
        );
      const on = enabled === true;
      ext.pluginsEnabled = ext.pluginsEnabled.filter((x) => x !== def.id);
      ext.pluginsDisabled = ext.pluginsDisabled.filter((x) => x !== def.id);
      if (def.defaultOn && !on) ext.pluginsDisabled.push(def.id);
      if (!def.defaultOn && on) ext.pluginsEnabled.push(def.id);
    }
    if (input.pack && typeof input.pack === "object") {
      const { id, mode } = input.pack as { id?: unknown; mode?: unknown };
      if (!SKILL_PACKS.some((p) => p.id === id))
        throw new HttpError(400, "unknown skill pack");
      if (mode !== "auto" && mode !== "on" && mode !== "off")
        throw new HttpError(400, "mode must be auto, on or off");
      ext.packModes[id as string] = mode;
    }
    if (input.browserAnyWebsite !== undefined)
      ext.browserAnyWebsite = input.browserAnyWebsite === true;
    this.data.extensions = ext;
    await this.save();
    return ext;
  }

  get sync(): SyncConfig {
    return this.data.sync;
  }

  syncView(): SyncConfigView {
    const { instructions, mcpServers, env } = this.data.sync;
    return {
      instructions,
      mcpServers,
      envSet: Object.keys(env).filter((k) => env[k]),
    };
  }

  /** Replaces shared instructions and MCP servers. `env` sets values; an empty string removes one. */
  async setSync(input: Record<string, unknown>): Promise<SyncConfigView> {
    const instructions =
      input.instructions === undefined
        ? this.data.sync.instructions
        : (str(input.instructions, "instructions", 20_000) ?? "");
    let mcpServers = this.data.sync.mcpServers;
    if (input.mcpServers !== undefined) {
      if (!Array.isArray(input.mcpServers) || input.mcpServers.length > 30)
        throw new HttpError(400, "mcpServers must be an array (max 30)");
      const seen = new Set<string>();
      mcpServers = input.mcpServers.map((raw, i): McpServer => {
        const m = (raw ?? {}) as Record<string, unknown>;
        const name = str(m.name, `mcpServers[${i}].name`, 40, true)!;
        if (!MCP_NAME.test(name))
          throw new HttpError(
            400,
            `MCP server name "${name}" may use letters, digits, - and _`,
          );
        if (seen.has(name))
          throw new HttpError(400, `duplicate MCP server "${name}"`);
        seen.add(name);
        const type = m.type === "http" ? "http" : "stdio";
        const envNames = Array.isArray(m.envNames)
          ? m.envNames.map(String).filter(Boolean)
          : [];
        for (const e of envNames)
          if (!ENV_NAME.test(e))
            throw new HttpError(
              400,
              `"${e}" is not a valid environment variable name`,
            );
        if (type === "http") {
          const url = str(m.url, `mcpServers[${i}].url`, 500, true)!;
          if (!/^https?:\/\//i.test(url))
            throw new HttpError(
              400,
              `MCP server "${name}" needs an http(s) URL`,
            );
          return { name, type, url, envNames };
        }
        const command = str(m.command, `mcpServers[${i}].command`, 300, true)!;
        const args = Array.isArray(m.args)
          ? m.args.map(String).slice(0, 40)
          : [];
        return { name, type, command, args, envNames };
      });
    }
    const env = { ...this.data.sync.env };
    if (input.env && typeof input.env === "object") {
      for (const [k, v] of Object.entries(
        input.env as Record<string, unknown>,
      )) {
        if (!ENV_NAME.test(k))
          throw new HttpError(
            400,
            `"${k}" is not a valid environment variable name`,
          );
        if (v === "" || v === null) delete env[k];
        else if (typeof v === "string" && v.length <= 4000) env[k] = v;
      }
    }
    this.data.sync = { instructions, mcpServers, env };
    await this.save();
    return this.syncView();
  }
}

/**
 * An ACP agent reference from the UI: { agentId, agentName, icon } for a registry agent, or
 * { command: "my-agent --acp" } for a custom one. The command runs on this computer only.
 */
export function parseAcpRef(raw: unknown): AcpRef {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.command === "string" && r.command.trim()) {
    const parts = splitCommand(r.command.trim().slice(0, 1000));
    if (!parts.length) throw new HttpError(400, "acp.command is empty");
    const name =
      str(r.agentName, "acp.agentName", 80) ?? parts[0]!.split(/[\\/]/).pop()!;
    return {
      agentId: `custom:${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
      agentName: name,
      command: parts[0],
      args: parts.slice(1),
    };
  }
  const agentId = str(r.agentId, "acp.agentId", 64, true)!;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(agentId))
    throw new HttpError(400, "acp.agentId is invalid");
  const icon = str(r.icon, "acp.icon", 500);
  return {
    agentId,
    agentName: str(r.agentName, "acp.agentName", 80) ?? agentId,
    icon:
      icon && /^https:\/\/cdn\.agentclientprotocol\.com\//.test(icon)
        ? icon
        : undefined,
  };
}

/** Splits a command line on spaces, keeping "quoted parts" together. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
