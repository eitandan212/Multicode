import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRegistry, platformKey } from "../server/acp/registry.js";
import {
  parseAcpRef,
  splitCommand,
  type Connection,
} from "../server/config.js";
import {
  AcpProvider,
  acpMcpServers,
  allowTool,
  insideRoot,
} from "../server/providers/acp.js";

/** A minimal ACP agent: asks to run a shell command, writes one file in and one outside the project. */
const FAKE_AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
let id = 1000; const waits = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const ask = (method, params) => new Promise((r) => { const i = id++; waits.set(i, r); send({ id: i, method, params }); });
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
console.log("agent log line that is not JSON");
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) return waits.get(m.id)?.(m);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (m.method === "session/new") return send({ id: m.id, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] } });
  if (m.method === "session/set_config_option") { process.stderr.write("model=" + m.params.value + "\\n"); return send({ id: m.id, result: {} }); }
  if (m.method === "session/prompt") {
    const s = m.params.sessionId;
    update(s, { sessionUpdate: "tool_call", toolCallId: "t1", title: "rm -rf /", kind: "execute", status: "pending" });
    const shell = await ask("session/request_permission", { sessionId: s, toolCall: { toolCallId: "t1", kind: "execute", title: "rm -rf /" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    const edit = await ask("session/request_permission", { sessionId: s, toolCall: { toolCallId: "t2", kind: "edit", title: "Edit a.txt" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    const inside = await ask("fs/write_text_file", { sessionId: s, path: process.cwd() + "/out/a.txt", content: "hello" });
    const outside = await ask("fs/write_text_file", { sessionId: s, path: "/tmp/../etc/evil.txt", content: "x" });
    const read = await ask("fs/read_text_file", { sessionId: s, path: "out/a.txt" });
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ shell: shell.result.outcome.optionId, edit: edit.result.outcome.optionId, inside: !inside.error, outsideError: Boolean(outside.error), read: read.result && read.result.content }) } });
    return send({ id: m.id, result: { stopReason: "end_turn", usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 } } });
  }
});
`;

describe("ACP", () => {
  let dir: string;
  let agentFile: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-acp-"));
    agentFile = path.join(dir, "..", `fake-acp-${path.basename(dir)}.cjs`);
    await writeFile(agentFile, FAKE_AGENT);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(agentFile, { force: true });
  });

  const conn = (): Connection => ({
    id: "c",
    kind: "acp",
    label: "Fake",
    acp: {
      agentId: "custom:fake",
      agentName: "Fake",
      command: process.execPath,
      args: [agentFile],
    },
  });

  it("runs a prompt: streams text, enforces permissions and keeps file access in the project", async () => {
    const usage: unknown[] = [];
    let live = "";
    const answer = await new AcpProvider(conn()).generate(
      {
        system: "s",
        prompt: "p",
        cwd: dir,
        mode: "edit",
        model: "b",
        onUsage: (u) => usage.push(u),
      },
      (d) => (live += d),
      AbortSignal.timeout(20_000),
    );
    expect(JSON.parse(answer)).toEqual({
      shell: "no",
      edit: "ok",
      inside: true,
      outsideError: true,
      read: "hello",
    });
    expect(await readFile(path.join(dir, "out", "a.txt"), "utf8")).toBe(
      "hello",
    );
    expect(live).toContain("▸ rm -rf /");
    expect(live).toContain("▸ Blocked by MultiCode: rm -rf /");
    expect(usage).toEqual([{ input: 10, output: 5 }]);
  });

  it("refuses writes and edit permissions in read-only tasks", async () => {
    const answer = await new AcpProvider(conn()).generate(
      { system: "s", prompt: "p", cwd: dir, mode: "text" },
      () => {},
      AbortSignal.timeout(20_000),
    );
    expect(JSON.parse(answer)).toMatchObject({
      shell: "no",
      edit: "no",
      inside: false,
    });
  });

  it("lists models from config options", async () => {
    expect(
      await new AcpProvider(conn()).listModels(AbortSignal.timeout(20_000)),
    ).toEqual(["a", "b"]);
  });

  it("reports an agent that dies", async () => {
    const bad: Connection = {
      ...conn(),
      acp: {
        agentId: "custom:x",
        agentName: "X",
        command: process.execPath,
        args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
      },
    };
    await expect(
      new AcpProvider(bad).generate(
        { system: "", prompt: "", cwd: dir, mode: "text" },
        () => {},
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow(/boom/);
  });

  it("permission policy and path guard", () => {
    expect(allowTool("read", "text")).toBe(true);
    expect(allowTool("edit", "text")).toBe(false);
    expect(allowTool("edit", "edit")).toBe(true);
    expect(allowTool("execute", "edit")).toBe(false);
    expect(allowTool("fetch", "edit")).toBe(false);
    expect(allowTool(undefined, "edit")).toBe(false);
    expect(insideRoot("/p", "src/a.ts")).toBe(path.resolve("/p/src/a.ts"));
    expect(() => insideRoot("/p", "../x")).toThrow();
    expect(() => insideRoot("/p", "/etc/passwd")).toThrow();
    expect(() => insideRoot("/p", "/p")).toThrow();
  });

  it("parses the registry defensively", () => {
    const agents = parseRegistry({
      agents: [
        {
          id: "good",
          name: "Good",
          distribution: {
            npx: { package: "@scope/pkg@1.2.3", args: ["--acp"] },
          },
        },
        {
          id: "bin",
          name: "Bin",
          distribution: {
            binary: {
              "linux-x86_64": {
                archive: "https://x/y.tar.gz",
                cmd: "./bin/a",
                sha256: "A".repeat(64),
              },
            },
          },
        },
        {
          id: "evil",
          name: "Evil",
          distribution: { npx: { package: "pkg; rm -rf /" } },
        },
        {
          id: "http",
          name: "Http",
          distribution: {
            binary: {
              "linux-x86_64": { archive: "http://x/y.zip", cmd: "./a" },
            },
          },
        },
        {
          id: "up",
          name: "Up",
          distribution: {
            binary: {
              "linux-x86_64": { archive: "https://x/y.zip", cmd: "../../a" },
            },
          },
        },
        { id: "Bad Id", name: "x", distribution: { npx: { package: "a" } } },
      ],
    });
    expect(agents.map((a) => a.id)).toEqual(["good", "bin"]);
    expect(agents[1]!.distribution.binary!["linux-x86_64"]!.sha256).toBe(
      "a".repeat(64),
    );
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
  });

  it("parses agent refs and command lines", () => {
    expect(splitCommand(`"C:\\Program Files\\a.exe" --acp 'x y'`)).toEqual([
      "C:\\Program Files\\a.exe",
      "--acp",
      "x y",
    ]);
    expect(parseAcpRef({ command: "goose acp" })).toMatchObject({
      agentId: "custom:goose",
      agentName: "goose",
      command: "goose",
      args: ["acp"],
    });
    expect(
      parseAcpRef({
        agentId: "gemini",
        agentName: "Gemini CLI",
        icon: "https://evil.example/x.svg",
      }),
    ).toEqual({ agentId: "gemini", agentName: "Gemini CLI", icon: undefined });
    expect(() => parseAcpRef({ agentId: "../x" })).toThrow();
  });

  it("maps shared MCP servers to ACP", async () => {
    const out = await acpMcpServers(
      [
        {
          name: "mem",
          type: "stdio",
          command: process.execPath,
          args: ["a"],
          envNames: ["K", "MISSING"],
          fixedEnv: { F: "1" },
        },
        { name: "web", type: "http", url: "https://x/mcp" },
      ],
      { K: "secret" },
      false,
    );
    expect(out).toEqual([
      {
        name: "mem",
        command: process.execPath,
        args: ["a"],
        env: [
          { name: "F", value: "1" },
          { name: "K", value: "secret" },
        ],
      },
    ]);
  });
});
