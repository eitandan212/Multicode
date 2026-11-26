// In-app updates: the newest version is described by downloads/latest.json in MultiCode's GitHub
// repository. The installer is downloaded, its SHA-256 checked against that file, then run
// silently with --relaunch, so MultiCode closes, updates and opens again by itself.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, net } from "electron";

const FEED =
  process.env.MULTICODE_UPDATE_URL ??
  "https://raw.githubusercontent.com/eitandan212/Multicode/HEAD/downloads/latest.json";

/** True when version a is newer than b (plain x.y.z). */
export function newer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** @returns {Promise<{ current: string, available: boolean, version?: string, size?: number, error?: string }>} */
const RELEASES = /^https:\/\/github\.com\/eitandan212\/Multicode\/releases\/download\/v\d+\.\d+\.\d+\/[\w.-]+\.exe$/;

export async function checkForUpdate() {
  const current = app.getVersion();
  try {
    const res = await net.fetch(`${FEED}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`update feed answered ${res.status}`);
    const latest = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(latest.version) || !/^[a-f0-9]{64}$/.test(latest.sha256) || !/^[\w.-]+\.exe$/.test(latest.file))
      throw new Error("the update feed looks wrong");
    return { current, available: newer(latest.version, current), version: latest.version, size: latest.size, latest };
  } catch (err) {
    return { current, available: false, error: String(err?.message ?? err) };
  }
}

/**
 * Downloads, verifies and starts the update. `onProgress` gets 0..1. Resolves just before the
 * app quits (or rejects with the reason nothing was installed).
 */
export async function installUpdate(onProgress) {
  const info = await checkForUpdate();
  if (info.error) throw new Error(info.error);
  if (!info.available) throw new Error("MultiCode is up to date");
  if (process.platform !== "win32" && !process.env.MULTICODE_UPDATE_DRYRUN)
    throw new Error("In-app updates install the Windows build; on this system, update from GitHub");
  const { latest } = info;
  // The installer sits next to the feed, or (newer feeds) on this repository's GitHub Releases.
  // Either way its SHA-256 must match the feed before it runs.
  const url =
    typeof latest.url === "string" && RELEASES.test(latest.url) && latest.url.endsWith(`/${latest.file}`)
      ? latest.url
      : new URL(latest.file, FEED).toString();
  const dir = path.join(os.tmpdir(), "multicode-update");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, latest.file);
  const res = await net.fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || latest.size || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(file);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    got += value.byteLength;
    if (total) onProgress(Math.min(1, got / total));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  const sum = hash.digest("hex");
  if (sum !== latest.sha256) {
    await rm(file, { force: true });
    throw new Error("the downloaded installer didn't match its checksum, so it wasn't run");
  }
  onProgress(1);
  if (process.env.MULTICODE_UPDATE_DRYRUN) return { file, version: latest.version };
  // Detached, so it outlives this app; /S = silent, --relaunch = open the new version after.
  spawn(file, ["/S", "--relaunch"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => app.quit(), 400);
  return { file, version: latest.version };
}
