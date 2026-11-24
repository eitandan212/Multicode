import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  API_KINDS,
  KIND_LABELS,
  type ConnectionView,
  type CrewMember,
  type ProviderKind,
  type Role,
  type Settings,
} from "./shared.js";

export interface Connection {
  id: string;
  kind: ProviderKind;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface ConfigData {
  connections: Connection[];
  crew: CrewMember[];
  settings: Settings;
}

const ALL_KINDS = Object.keys(KIND_LABELS) as ProviderKind[];
const ROLES: Role[] = ["architect", "builder", "reviewer"];

export function dataDir(): string {
  return process.env.MULTICODE_HOME ?? path.join(homedir(), ".multicode");
}

function emptyConfig(): ConfigData {
  return { connections: [], crew: [], settings: { maxReviewRounds: 2 } };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function str(v: unknown, field: string, max = 500, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
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
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<ConfigData>;
      this.data = {
        connections: Array.isArray(raw.connections) ? raw.connections : [],
        crew: Array.isArray(raw.crew) ? raw.crew : [],
        settings: { ...emptyConfig().settings, ...(raw.settings ?? {}) },
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
      hasKey: Boolean(c.apiKey),
      keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : undefined,
    }));
  }

  async upsertConnection(input: Record<string, unknown>, id?: string): Promise<Connection> {
    const existing = id ? this.connection(id) : undefined;
    if (id && !existing) throw new HttpError(404, "connection not found");
    const kind = (existing?.kind ?? input.kind) as ProviderKind;
    if (!ALL_KINDS.includes(kind)) throw new HttpError(400, "unknown provider kind");

    const apiKey = str(input.apiKey, "apiKey", 4000);
    const next: Connection = {
      id: existing?.id ?? randomUUID(),
      kind,
      label: str(input.label, "label", 80) ?? existing?.label ?? KIND_LABELS[kind],
      apiKey: apiKey ?? existing?.apiKey,
      baseUrl: input.baseUrl === undefined ? existing?.baseUrl : str(input.baseUrl, "baseUrl", 500),
      defaultModel:
        input.defaultModel === undefined ? existing?.defaultModel : str(input.defaultModel, "defaultModel", 200),
    };
    if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) throw new HttpError(400, "baseUrl must be http(s)");
    if (kind === "openai-compatible" && !next.baseUrl) throw new HttpError(400, "baseUrl is required");
    if (API_KINDS.includes(kind) && kind !== "openai-compatible" && !next.apiKey)
      throw new HttpError(400, "apiKey is required");

    if (existing) Object.assign(existing, next);
    else this.data.connections.push(next);
    await this.save();
    return existing ?? next;
  }

  async deleteConnection(id: string): Promise<void> {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    if (this.data.connections.length === before) throw new HttpError(404, "connection not found");
    this.data.crew = this.data.crew.filter((m) => m.connectionId !== id);
    await this.save();
  }

  async setCrew(input: unknown): Promise<CrewMember[]> {
    if (!Array.isArray(input) || input.length > 20) throw new HttpError(400, "crew must be an array (max 20)");
    const crew = input.map((raw, i): CrewMember => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const role = m.role as Role;
      if (!ROLES.includes(role)) throw new HttpError(400, `crew[${i}].role is invalid`);
      const connectionId = str(m.connectionId, `crew[${i}].connectionId`, 100, true)!;
      if (!this.connection(connectionId)) throw new HttpError(400, `crew[${i}] uses an unknown connection`);
      return {
        id: str(m.id, "id", 100) ?? randomUUID(),
        name: str(m.name, `crew[${i}].name`, 40) ?? `Agent ${i + 1}`,
        role,
        connectionId,
        model: str(m.model, `crew[${i}].model`, 200),
      };
    });
    this.data.crew = crew;
    await this.save();
    return crew;
  }

  async setSettings(input: Record<string, unknown>): Promise<Settings> {
    const rounds = Number(input.maxReviewRounds);
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 5)
      throw new HttpError(400, "maxReviewRounds must be an integer 0-5");
    this.data.settings = { ...this.data.settings, maxReviewRounds: rounds };
    await this.save();
    return this.data.settings;
  }
}
