// Google Antigravity, connected the way T3 Code connects it: Google's `agy` CLI run as an ACP
// agent (`agy acp`), installed from Google's own release manifest (checked against its SHA-512),
// and signed in with `agy acp --login` (a Google page, then a code pasted back).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir, HttpError } from "./config.js";
import { findBinary } from "./providers/cli.js";

/** Google's release manifests for the Antigravity CLI (one JSON per platform). */
const MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const DOWNLOAD_PREFIX = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
/** What `agy acp` prints when it needs a Google sign-in. */
export const AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
const MAX_DOWNLOAD = 512 * 1024 * 1024;

/** The process environment for agy: no self-updates mid-run, unbuffered output. */
export const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true", PYTHONUNBUFFERED: "1" };

const installDir = () => path.join(dataDir(), "agents", "antigravity");
const exeName = () => (process.platform === "win32" ? "agy.exe" : "agy");

/** Where agy is: on PATH (installed by the Antigravity app or by hand), or installed by MultiCode. */
export async function findAgy(): Promise<string | undefined> {
  const own = path.join(installDir(), exeName());
  if (await access(own).then(() => true, () => false)) return own;
  return findBinary("agy");
}

export async function agyLaunch(): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const agy = await findAgy();
  if (!agy) throw new HttpError(409, "Antigravity isn't installed yet. Open Connections and press Install.");
  return { command: agy, args: ["acp"], env: AGY_ENV };
}

/** The manifest target for this computer, e.g. windows_amd64 or darwin_arm64. */
export function agyTarget(platform = process.platform, arch = process.arch): string | null {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  return `${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : arch}`;
}

/** Downloads Google's current agy for this computer, verifies it, and puts it in MultiCode's data. */
export async function installAgy(): Promise<{ ok: boolean; output: string }> {
  const target = agyTarget();
  if (!target) throw new HttpError(400, "Antigravity has no build for this computer");
  const res = await fetch(`${MANIFEST_BASE}/${target}.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(502, `Google's Antigravity release list answered ${res.status}`);
  const m = (await res.json()) as { version?: string; url?: string; sha512?: string };
  if (
    !/^\d+\.\d+\.\d+$/.test(m.version ?? "") ||
    !/^[a-f0-9]{128}$/i.test(m.sha512 ?? "") ||
    !m.url?.startsWith(DOWNLOAD_PREFIX)
  )
    throw new HttpError(502, "Google's Antigravity release list looks wrong, so nothing was installed");

  const dir = installDir();
  const staging = path.join(dir, `.download-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    const file = path.join(staging, process.platform === "win32" ? exeName() : "agy.tar.gz");
    const dl = await fetch(m.url, { signal: AbortSignal.timeout(45 * 60_000) });
    if (!dl.ok || !dl.body) throw new HttpError(502, `Antigravity download failed (${dl.status})`);
    const hash = createHash("sha512");
    const out = createWriteStream(file);
    let size = 0;
    for await (const chunk of dl.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD) throw new HttpError(502, "The Antigravity download was larger than expected");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    if (hash.digest("hex") !== m.sha512!.toLowerCase())
      throw new HttpError(502, "The Antigravity download didn't match Google's checksum, so it wasn't installed");

    let exe = file;
    if (process.platform !== "win32") {
      await run("tar", ["-xzf", file, "-C", staging]);
      exe = (await findFile(staging, ["antigravity", "agy"])) ?? "";
      if (!exe) throw new HttpError(502, "The Antigravity download had no program in it");
      await chmod(exe, 0o755);
    }
    await rm(path.join(dir, exeName()), { force: true });
    await rename(exe, path.join(dir, exeName()));
    return { ok: true, output: `Antigravity ${m.version} installed` };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function findFile(dir: string, names: string[]): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && names.includes(e.name)) return p;
    if (e.isDirectory()) {
      const inner = await findFile(p, names);
      if (inner) return inner;
    }
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/**
 * Whether agy is signed in: starts `agy acp`, asks for a session, and watches for its sign-in
 * link. A session means yes; the link (or an auth error) means no.
 */
export async function agyStatus(ms = 45_000): Promise<{ signedIn: boolean; problem?: string }> {
  const agy = await findAgy();
  if (!agy) return { signedIn: false };
  const cwd = path.join(dataDir(), "agents", "antigravity", "probe");
  await mkdir(cwd, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(agy, ["acp"], {
      cwd,
      env: { ...process.env, ...AGY_ENV },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    const done = (r: { signedIn: boolean; problem?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done({ signedIn: false, problem: "Antigravity didn't answer in time" }), ms);
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith(AUTH_PREFIX) || /authenticate/i.test(line)) return done({ signedIn: false });
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { sessionId?: string }; error?: { message?: string } };
          if (msg.id === 1 && msg.result) send({ id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
          else if (msg.id === 2 && msg.result?.sessionId) done({ signedIn: true });
          else if (msg.error) done({ signedIn: false, ...(/auth|sign|login/i.test(msg.error.message ?? "") ? {} : { problem: msg.error.message }) });
        } catch {
          /* not JSON-RPC */
        }
      }
    });
    child.on("error", (e) => done({ signedIn: false, problem: e.message }));
    child.on("close", () => done({ signedIn: false, problem: "Antigravity stopped before answering" }));
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "multicode", title: "MultiCode", version: "0.3" },
      },
    });
  });
}

