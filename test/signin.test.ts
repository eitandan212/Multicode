import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { npmPackageOf, SignIn } from "../server/signin.js";

/** A stand-in `claude`: `auth status --json` reads a file; `auth login` prints a link, takes a code. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.FAKE_STATE;
const [a, b] = process.argv.slice(2);
if (a === "auth" && b === "status") {
  const on = fs.existsSync(state);
  console.log(JSON.stringify({ loggedIn: on, authMethod: on ? "claude.ai" : "none", email: on ? "me@example.com" : undefined }));
} else if (a === "auth" && b === "login") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc");
  process.stdout.write("Paste code here if prompted > ");
  process.stdin.once("data", (d) => {
    if (String(d).trim() === "GOOD") { fs.writeFileSync(state, "1"); console.log("Login successful."); process.exit(0); }
    console.log("Invalid code"); process.exit(1);
  });
}
`;

/** A stand-in `codex app-server` that signs in through ChatGPT. */
const FAKE_CODEX = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let signedIn = false;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  if (m.method === "account/read") return send({ id: m.id, result: { account: signedIn ? { type: "chatgpt", email: "me@example.com", planType: "plus" } : null, requiresOpenaiAuth: true } });
  if (m.method === "account/login/start") {
    send({ id: m.id, result: { type: "chatgpt", authUrl: "https://auth.openai.com/oauth/authorize?x=1", loginId: "L1" } });
    setTimeout(() => { signedIn = true; send({ method: "account/login/completed", params: { loginId: "L1", success: true } }); }, 200);
  }
});
`;

describe("one-click sign-in", () => {
  let dir: string;
  const oldPath = process.env.PATH;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-signin-"));
    await writeFile(path.join(dir, "claude"), FAKE_CLAUDE);
    await writeFile(path.join(dir, "codex"), FAKE_CODEX);
    await chmod(path.join(dir, "claude"), 0o755);
    await chmod(path.join(dir, "codex"), 0o755);
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    process.env.FAKE_STATE = path.join(dir, "claude-signed-in");
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_STATE;
    await rm(dir, { recursive: true, force: true });
  });

  const until = async (signIn: SignIn, id: string) => {
    for (let i = 0; i < 100; i++) {
      const f = signIn.view(id);
      if (f.state !== "waiting") return f;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("sign-in never finished");
  };

  it("signs in to Claude Code with the code from the sign-in page", async () => {
    const s = new SignIn();
    expect(await s.access("claude-cli")).toMatchObject({ installed: true, signedIn: false });
    const flow = await s.start("claude-cli");
    for (let i = 0; i < 50 && !s.view(flow.id).wantsCode; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.view(flow.id)).toMatchObject({ url: "https://claude.ai/oauth/authorize?code=true&state=abc", wantsCode: true });
    s.code(flow.id, "GOOD");
    expect((await until(s, flow.id)).state).toBe("done");
    expect(await s.access("claude-cli")).toMatchObject({ signedIn: true, account: "me@example.com" });
    await rm(process.env.FAKE_STATE!, { force: true });
  });

  it("reports a failed Claude sign-in with its reason", async () => {
    const s = new SignIn();
    const flow = await s.start("claude-cli");
    for (let i = 0; i < 50 && !s.view(flow.id).wantsCode; i++) await new Promise((r) => setTimeout(r, 100));
    s.code(flow.id, "WRONG");
    const done = await until(s, flow.id);
    expect(done.state).toBe("error");
    expect(done.message).toMatch(/Invalid code/);
  });

  it("signs in to Codex through its own ChatGPT login", async () => {
    const s = new SignIn();
    expect(await s.access("codex-cli")).toMatchObject({ installed: true, signedIn: false });
    const flow = await s.start("codex-cli");
    expect(flow.url).toBe("https://auth.openai.com/oauth/authorize?x=1");
    expect((await until(s, flow.id)).state).toBe("done");
  });

  it("knows which npm package installs each agent", () => {
    expect(npmPackageOf("claude-cli")).toBe("@anthropic-ai/claude-code");
    expect(npmPackageOf("codex-cli")).toBe("@openai/codex");
    expect(npmPackageOf("opencode-cli")).toBe("opencode-ai");
  });

  it("refuses agents it can't sign in to", async () => {
    await expect(new SignIn().start("gemini-cli")).rejects.toThrow(/Claude Code and Codex/);
  });
});
