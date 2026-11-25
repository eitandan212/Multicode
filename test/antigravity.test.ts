import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agyStatus, agyTarget, AUTH_PREFIX } from "../server/antigravity.js";
import { createProvider } from "../server/providers/registry.js";
import { SignIn } from "../server/signin.js";

/** A stand-in `agy`: signed out it prints Google's link; --login takes a code; signed in it speaks ACP. */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.FAKE_AGY_STATE;
const login = process.argv.includes("--login");
const signedIn = () => fs.existsSync(state);
const rl = require("node:readline").createInterface({ input: process.stdin });
if (login || !signedIn()) console.log(${JSON.stringify(AUTH_PREFIX)} + "https://accounts.google.com/o/oauth2/auth?x=1");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
  if (login && !line.startsWith("{")) { if (line.trim() === "GOOD") fs.writeFileSync(state, "1"); return; }
  const m = JSON.parse(line);
  if (!signedIn()) return; // waits for a sign-in, as agy does
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
});
`;

describe("Antigravity", () => {
  let dir: string;
  const oldPath = process.env.PATH;
  const oldHome = process.env.MULTICODE_HOME;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-agy-"));
    await writeFile(path.join(dir, "agy"), FAKE_AGY);
    await chmod(path.join(dir, "agy"), 0o755);
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    process.env.MULTICODE_HOME = path.join(dir, "home");
    process.env.FAKE_AGY_STATE = path.join(dir, "signed-in");
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.MULTICODE_HOME;
    else process.env.MULTICODE_HOME = oldHome;
    delete process.env.FAKE_AGY_STATE;
    await rm(dir, { recursive: true, force: true });
  });

  it("knows Google's build for each computer", () => {
    expect(agyTarget("win32", "x64")).toBe("windows_amd64");
    expect(agyTarget("darwin", "arm64")).toBe("darwin_arm64");
    expect(agyTarget("linux", "x64")).toBe("linux_amd64");
    expect(agyTarget("aix", "x64")).toBeNull();
  });

  it("a run that needs a sign-in stops at once and says so", async () => {
    const p = createProvider({ id: "g", kind: "antigravity", label: "Antigravity" });
    const started = Date.now();
    await expect(
      p.generate({ system: "", prompt: "hi", cwd: path.join(dir, "proj"), mode: "text" }, () => {}, AbortSignal.timeout(20_000)),
    ).rejects.toThrow(/isn't signed in/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("signs in with Google's code and then reports signed in", async () => {
    expect((await agyStatus(10_000)).signedIn).toBe(false);
    const s = new SignIn();
    expect(await s.access("antigravity")).toMatchObject({ installed: true, signedIn: false });
    const flow = await s.start("antigravity");
    for (let i = 0; i < 50 && !s.view(flow.id).wantsCode; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.view(flow.id).url).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
    s.code(flow.id, "GOOD");
    for (let i = 0; i < 150 && s.view(flow.id).state === "waiting"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.view(flow.id).state).toBe("done");
    expect(await s.access("antigravity")).toMatchObject({ signedIn: true });
  }, 30_000);
});
