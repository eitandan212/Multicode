// The Agent Client Protocol registry: the open list of coding agents that speak ACP
// (https://agentclientprotocol.com). MultiCode reads it to offer every listed agent as a
// connection, the same way T3 Code does, and installs an agent only when the user asks.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir } from "../config.js";
import { findBinary } from "../providers/cli.js";
import type { AcpAgentView } from "../shared.js";

const run = promisify(execFile);
export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 6 * 3600_000;
const MAX_REGISTRY_BYTES = 2_000_000;
const MAX_ARCHIVE_BYTES = 400_000_000;

interface BinaryTarget {
  archive: string;
  cmd: string;
  args?: string[];
  sha256?: string;
  env?: Record<string, string>;
}
interface PackageTarget {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface RegistryAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  website?: string;
  repository?: string;
  license?: string;
  icon?: string;
  distribution: {
    npx?: PackageTarget;
    uvx?: PackageTarget;
    binary?: Record<string, BinaryTarget>;
  };
}

/** What MultiCode spawns for an agent: a command, its arguments and extra environment. */
export interface AcpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PKG_RE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/;

/** Keeps only well-formed entries; anything odd in the remote file is dropped, not trusted. */
export function parseRegistry(json: unknown): RegistryAgent[] {
  const agents = (json as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) throw new Error("registry has no agents list");
  const out: RegistryAgent[] = [];
  for (const raw of agents.slice(0, 500)) {
    const a = raw as Partial<RegistryAgent>;
    if (
      typeof a?.id !== "string" ||
      !ID_RE.test(a.id) ||
      typeof a.name !== "string" ||
      !a.distribution
    )
      continue;
    const d = a.distribution;
    const pkg = (p?: PackageTarget) =>
      p && typeof p.package === "string" && PKG_RE.test(p.package)
        ? { package: p.package, args: strings(p.args), env: envOf(p.env) }
        : undefined;
    const binary: Record<string, BinaryTarget> = {};
    for (const [platform, t] of Object.entries(d.binary ?? {})) {
      if (
        !t ||
        typeof t.archive !== "string" ||
        !/^https:\/\//.test(t.archive) ||
        typeof t.cmd !== "string"
      )
        continue;
      if (t.cmd.includes("..")) continue;
      binary[platform] = {
        archive: t.archive,
        cmd: t.cmd,
        args: strings(t.args),
        sha256:
          typeof t.sha256 === "string" && /^[a-f0-9]{64}$/i.test(t.sha256)
            ? t.sha256.toLowerCase()
            : undefined,
        env: envOf(t.env),
      };
    }
    const distribution = {
      npx: pkg(d.npx),
      uvx: pkg(d.uvx),
      binary: Object.keys(binary).length ? binary : undefined,
    };
    if (!distribution.npx && !distribution.uvx && !distribution.binary)
      continue;
    out.push({
      id: a.id,
      name: a.name.slice(0, 80),
      version:
        typeof a.version === "string" ? a.version.slice(0, 40) : undefined,
      description:
        typeof a.description === "string"
          ? a.description.slice(0, 300)
          : undefined,
      website: httpsOrUndef(a.website),
      repository: httpsOrUndef(a.repository),
      license:
        typeof a.license === "string" ? a.license.slice(0, 40) : undefined,
      icon: httpsOrUndef(a.icon),
      distribution,
    });
  }
  return out;
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string").slice(0, 20)
    : undefined;
}
function envOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v))
    if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof val === "string") out[k] = val;
  return Object.keys(out).length ? out : undefined;
}
function httpsOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && /^https:\/\//.test(v)
    ? v.slice(0, 500)
    : undefined;
}

/** The registry's platform key for this computer, e.g. "linux-x86_64" or "windows-x86_64". */
export function platformKey(
  platform = process.platform,
  arch = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return `${os}-${cpu}`;
}

let memo: { at: number; agents: RegistryAgent[] } | undefined;

/** The registry, from a 6-hour cache; falls back to the last saved copy when offline. */
export async function loadRegistry(
  opts: { refresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<RegistryAgent[]> {
  if (!opts.refresh && memo && Date.now() - memo.at < CACHE_TTL_MS)
    return memo.agents;
  const file = path.join(dataDir(), "acp", "registry.json");
  if (!opts.refresh) {
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < CACHE_TTL_MS) {
        memo = {
          at: s.mtimeMs,
          agents: parseRegistry(JSON.parse(await readFile(file, "utf8"))),
        };
        return memo.agents;
      }
    } catch {
      // no usable cache: fetch below
    }
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(ACP_REGISTRY_URL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_REGISTRY_BYTES)
      throw new Error("registry is too large");
    const agents = parseRegistry(JSON.parse(text));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    memo = { at: Date.now(), agents };
    return agents;
  } catch (err) {
    try {
      const agents = parseRegistry(JSON.parse(await readFile(file, "utf8")));
      memo = { at: Date.now() - CACHE_TTL_MS + 600_000, agents };
      return agents;
    } catch {
      throw new Error(
        `Couldn't load the ACP agent registry: ${(err as Error).message}`,
      );
    }
  }
}

function installDir(agent: RegistryAgent): string {
  return path.join(
    dataDir(),
    "acp",
    "agents",
    agent.id,
    agent.version ?? "latest",
  );
}

/** How to start an agent on this computer, or why it can't be started yet. */
export async function resolveAgent(agent: RegistryAgent): Promise<{
  launch?: AcpLaunch;
  method?: AcpAgentView["method"];
  needsInstall?: boolean;
  reason?: string;
}> {
  const d = agent.distribution;
  const bin = d.binary?.[platformKey()];
  if (bin) {
    const local = path.join(installDir(agent), bin.cmd);
    const exe =
      process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(local)
        ? `${local}.exe`
        : local;
    for (const candidate of [local, exe]) {
      if (await exists(candidate))
        return {
          launch: { command: candidate, args: bin.args ?? [], env: bin.env },
          method: "binary",
        };
    }
    // Already on PATH (e.g. installed by its own installer)? Use that copy.
    const onPath = await findBinary(
      path.basename(bin.cmd).replace(/\.exe$/i, ""),
    );
    if (onPath)
      return {
        launch: { command: onPath, args: bin.args ?? [], env: bin.env },
        method: "path",
      };
  }
  if (d.npx) {
    if (!(await findBinary("npx")))
      return {
        reason: "Needs Node.js (npx). Install Node.js 20+ from nodejs.org.",
      };
    return {
      launch: {
        command: "npx",
        args: ["-y", d.npx.package, ...(d.npx.args ?? [])],
        env: d.npx.env,
      },
      method: "npx",
    };
  }
  if (d.uvx) {
    if (!(await findBinary("uvx")))
      return { reason: "Needs uv (uvx). Install it from docs.astral.sh/uv." };
    return {
      launch: {
        command: "uvx",
        args: [d.uvx.package, ...(d.uvx.args ?? [])],
        env: d.uvx.env,
      },
      method: "uvx",
    };
  }
  if (bin) return { needsInstall: true, method: "binary" };
  return { reason: `No build for ${platformKey()}.` };
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Downloads, checks (sha256 when the registry lists one) and unpacks an agent's binary. */
export async function installAgent(
  agent: RegistryAgent,
  fetchImpl: typeof fetch = fetch,
): Promise<AcpLaunch> {
  const target = agent.distribution.binary?.[platformKey()];
  if (!target)
    throw new Error(`${agent.name} has no download for ${platformKey()}`);
  const dir = installDir(agent);
  const tmp = `${dir}.part-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const res = await fetchImpl(target.archive, {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_BYTES)
      throw new Error("download is too large");
    if (target.sha256) {
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== target.sha256)
        throw new Error(
          "download checksum doesn't match the registry; not installed",
        );
    }
    const name = new URL(target.archive).pathname.split("/").pop() ?? "agent";
    const archive = path.join(tmp, name.replace(/[^\w.-]/g, "_"));
    await writeFile(archive, bytes);
    await extract(archive, tmp);
    await rm(archive, { force: true });
    const cmd = path.join(tmp, target.cmd);
    if (process.platform !== "win32") await chmod(cmd, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  const resolved = await resolveAgent(agent);
  if (!resolved.launch)
    throw new Error(`${agent.name} was unpacked but its program wasn't found`);
  return resolved.launch;
}

async function extract(archive: string, into: string): Promise<void> {
  const lower = archive.toLowerCase();
  if (/\.(exe)$/.test(lower)) return; // a bare executable: nothing to unpack
  // bsdtar (Windows 10+, macOS) unpacks zip too; GNU tar on Linux needs unzip for zip files.
  if (lower.endsWith(".zip") && process.platform === "linux") {
    await run("unzip", ["-q", "-o", archive, "-d", into], {
      maxBuffer: 10_000_000,
    });
    return;
  }
  await run("tar", ["-xf", archive, "-C", into], {
    maxBuffer: 10_000_000,
    windowsHide: true,
  });
}

/** The registry, as the UI shows it: one row per agent with how it would run here. */
export async function registryView(
  agents: RegistryAgent[],
): Promise<AcpAgentView[]> {
  return Promise.all(
    agents.map(async (a) => {
      const r = await resolveAgent(a);
      return {
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        website: a.website ?? a.repository,
        icon: a.icon,
        method: r.method,
        ready: Boolean(r.launch),
        needsInstall: Boolean(r.needsInstall),
        reason: r.reason,
      };
    }),
  );
}
