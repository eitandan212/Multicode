import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Connection } from "../server/config.js";
import {
  ClaudeSdkProvider,
  claudeMcpServers,
  claudeToolDecision,
} from "../server/providers/claude.js";
import {
  codexApproval,
  CodexAppServerProvider,
  codexItemLabel,
} from "../server/providers/codex.js";
import { FallbackProvider } from "../server/providers/fallback.js";
import type { Provider } from "../server/providers/types.js";

/** A stand-in `codex app-server`: Codex's JSON-RPC protocol, one message per line, in the shapes
 * Codex's generated schema requires (T3 Code's client validates every message). */
const FAKE_CODEX = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const signedIn = process.env.FAKE_SIGNED_IN !== "0";
let id = 9000; const waits = new Map(); let sawDev = "";
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 150 };
const model = (id, hidden) => ({ id, model: id, displayName: id, description: "", hidden, isDefault: !hidden, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const ask = (method, params) => new Promise((r) => { const i = id++; waits.set(i, r); send({ id: i, method, params }); });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) return waits.get(m.id)?.(m);
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  if (m.method === "initialized") return;
  if (m.method === "account/read") return send({ id: m.id, result: { account: signedIn ? { type: "chatgpt", email: "a@b.c", planType: "plus" } : null, requiresOpenaiAuth: true } });
  if (m.method === "model/list") return send({ id: m.id, result: { data: [model("gpt-5.6-luna", false), model("hidden", true)], nextCursor: null } });
  if (m.method === "thread/start") { sawDev = m.params.developerInstructions + "|" + m.params.sandbox + "|" + m.params.approvalPolicy + "|" + (m.params.model ?? ""); return send({ id: m.id, result: { approvalPolicy: "never", approvalsReviewer: "user", cwd: "/tmp", model: "m", modelProvider: "openai", sandbox: { type: "readOnly" }, thread: { id: "th1", cliVersion: "0", createdAt: 0, updatedAt: 0, cwd: "/tmp", ephemeral: true, modelProvider: "openai", preview: "", projectId: null, sessionId: "s1", source: "appServer", status: { type: "idle" }, turns: [] } } }); }
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "tu1", items: [], status: "inProgress" } } });
    const t = { threadId: "th1", turnId: "tu1" };
    send({ method: "item/started", params: { ...t, startedAtMs: 0, item: { type: "commandExecution", id: "c1", command: "npm test", commandActions: [], cwd: "/tmp", status: "inProgress" } } });
    const cmd = await ask("item/commandExecution/requestApproval", { ...t, itemId: "i1", startedAtMs: 0 });
    const edit = await ask("item/fileChange/requestApproval", { ...t, itemId: "i2", startedAtMs: 0 });
    send({ method: "item/started", params: { ...t, startedAtMs: 0, item: { type: "fileChange", id: "f1", changes: [{ path: "a.js", kind: { type: "add" }, diff: "" }], status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { ...t, itemId: "m", delta: "Done: " + cmd.result.decision + "/" + edit.result.decision + " " } });
    send({ method: "item/agentMessage/delta", params: { ...t, itemId: "m", delta: sawDev } });
    send({ method: "thread/tokenUsage/updated", params: { ...t, tokenUsage: { total: usage, last: usage } } });
    send({ method: "turn/completed", params: { threadId: "th1", turn: { id: "tu1", items: [], status: process.env.FAKE_FAIL ? "failed" : "completed", error: process.env.FAKE_FAIL ? { message: "model overloaded" } : null } } });
  }
});
`;

describe("Codex app-server connection", () => {
  let dir: string;
  let script: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-codex-"));
    script = path.join(dir, "..", `fake-codex-${path.basename(dir)}.cjs`);
    await writeFile(script, FAKE_CODEX);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(script, { force: true });
  });
  const conn: Connection = {
    id: "c",
    kind: "codex-cli",
    label: "Codex",
    defaultModel: "gpt-5.6-luna",
  };
  const provider = () =>
    new CodexAppServerProvider(conn, async () => ({
      command: process.execPath,
      args: [script],
    }));

  it("runs a turn: streams text and tools, declines commands, accepts edits, reports usage", async () => {
    let live = "";
    const usage: unknown[] = [];
    const answer = await provider().generate(
      {
        system: "SYS",
        prompt: "build it",
        cwd: dir,
        mode: "edit",
        onUsage: (u) => usage.push(u),
      },
      (d) => (live += d),
      AbortSignal.timeout(15_000),
    );
    expect(answer).toBe(
      "Done: decline/accept SYS|workspace-write|never|gpt-5.6-luna",
    );
    expect(live).toContain("▸ $ npm test");
    expect(live).toContain("▸ Edit a.js");
    expect(usage).toEqual([{ input: 120, output: 30 }]);
  });

  it("read-only tasks use the read-only sandbox and decline edits", async () => {
    const answer = await provider().generate(
      { system: "S", prompt: "p", cwd: dir, mode: "text" },
      () => {},
      AbortSignal.timeout(15_000),
    );
    expect(answer).toContain("decline/decline");
    expect(answer).toContain("|read-only|never|");
  });

  it("says plainly when Codex isn't signed in, and lists models without signing in", async () => {
    process.env.FAKE_SIGNED_IN = "0";
    try {
      await expect(
        provider().generate(
          { system: "", prompt: "", cwd: dir, mode: "text" },
          () => {},
          AbortSignal.timeout(15_000),
        ),
      ).rejects.toThrow(/codex login/);
      expect(await provider().listModels(AbortSignal.timeout(15_000))).toEqual([
        "gpt-5.6-luna",
      ]);
    } finally {
      delete process.env.FAKE_SIGNED_IN;
    }
  });

  it("reports a failed turn with Codex's reason", async () => {
    process.env.FAKE_FAIL = "1";
    try {
      await expect(
        provider().generate(
          { system: "", prompt: "", cwd: dir, mode: "edit" },
          () => {},
          AbortSignal.timeout(15_000),
        ),
      ).rejects.toThrow(/model overloaded/);
    } finally {
      delete process.env.FAKE_FAIL;
    }
  });

  it("labels items and answers approvals by policy", () => {
    expect(
      codexItemLabel({ type: "mcpToolCall", server: "memory", tool: "search" }),
    ).toBe("memory.search");
    expect(codexItemLabel({ type: "reasoning" })).toBeUndefined();
    expect(
      codexApproval("item/commandExecution/requestApproval", "edit"),
    ).toEqual({ decision: "decline" });
    expect(codexApproval("item/fileChange/requestApproval", "text")).toEqual({
      decision: "decline",
    });
    expect(codexApproval("item/tool/requestUserInput", "edit")).toBeUndefined();
  });
});

describe("Claude Agent SDK connection", () => {
  const conn: Connection = {
    id: "a",
    kind: "claude-cli",
    label: "Claude Code",
    defaultModel: "claude-opus-5-5",
  };
  const exe = async () => ({ pathToClaudeCodeExecutable: "/usr/bin/claude" });

  /** A stand-in for query(): asks permission like Claude Code would, then answers. */
  function fakeQuery(
    seen: { options?: Options; decisions: string[] },
    error?: "authentication_failed",
  ) {
    return async function* ({
      options,
    }: {
      prompt: string;
      options?: Options;
    }): AsyncGenerator<SDKMessage> {
      seen.options = options;
      for (const [tool, input] of [
        ["Bash", { command: "rm -rf /" }],
        ["Write", { file_path: "/etc/passwd" }],
        ["Write", { file_path: "src/a.ts" }],
        ["mcp__memory__search", {}],
      ] as const) {
        const r = await options!.canUseTool!(
          tool,
          input as Record<string, unknown>,
          { signal: new AbortController().signal } as never,
        );
        seen.decisions.push(`${tool}:${r.behavior}`);
      }
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "Read",
              input: { file_path: "a.ts" },
            },
          ],
        },
        parent_tool_use_id: null,
        ...(error ? { error } : {}),
      } as unknown as SDKMessage;
      for (const text of ["Hello ", "world"])
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
          parent_tool_use_id: null,
        } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello world",
        total_cost_usd: 0.012,
        usage: { input_tokens: 50, output_tokens: 7 },
      } as unknown as SDKMessage;
    };
  }

  it("streams, reports usage and cost, and enforces MultiCode's tool policy", async () => {
    const seen = { decisions: [] as string[] } as {
      options?: Options;
      decisions: string[];
    };
    const usage: unknown[] = [];
    let live = "";
    const answer = await new ClaudeSdkProvider(
      conn,
      fakeQuery(seen) as never,
      exe,
    ).generate(
      {
        system: "SYS",
        prompt: "go",
        cwd: "/proj",
        mode: "edit",
        onUsage: (u) => usage.push(u),
      },
      (d) => (live += d),
      AbortSignal.timeout(5000),
    );
    expect(answer).toBe("Hello world");
    expect(usage).toEqual([{ input: 50, output: 7, costUsd: 0.012 }]);
    expect(seen.decisions).toEqual([
      "Bash:deny",
      "Write:deny",
      "Write:allow",
      "mcp__memory__search:allow",
    ]);
    expect(live).toContain("▸ Blocked by MultiCode: Bash rm -rf /");
    expect(live).toContain("▸ Read a.ts");
    expect(seen.options).toMatchObject({
      cwd: "/proj",
      model: "claude-opus-5-5",
      permissionMode: "acceptEdits",
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      systemPrompt: { type: "preset", preset: "claude_code", append: "SYS" },
      persistSession: false,
    });
  });

  it("plans in read-only tasks and refuses every edit there", async () => {
    const seen = { decisions: [] as string[] } as {
      options?: Options;
      decisions: string[];
    };
    await new ClaudeSdkProvider(conn, fakeQuery(seen) as never, exe).generate(
      { system: "", prompt: "", cwd: "/proj", mode: "text" },
      () => {},
      AbortSignal.timeout(5000),
    );
    expect(seen.options?.permissionMode).toBe("plan");
    expect(seen.decisions).toEqual([
      "Bash:deny",
      "Write:deny",
      "Write:deny",
      "mcp__memory__search:allow",
    ]);
  });

  it("explains a missing sign-in", async () => {
    const seen = { decisions: [] as string[] } as {
      options?: Options;
      decisions: string[];
    };
    await expect(
      new ClaudeSdkProvider(
        conn,
        fakeQuery(seen, "authentication_failed") as never,
        exe,
      ).generate(
        { system: "", prompt: "", cwd: "/proj", mode: "edit" },
        () => {},
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow(/sign/);
  });

  it("decides tools and maps MCP servers", () => {
    expect(claudeToolDecision("Grep", {}, "text", "/p")).toEqual({
      allow: true,
    });
    expect(
      claudeToolDecision("Edit", { file_path: "../x" }, "edit", "/p").allow,
    ).toBe(false);
    expect(claudeToolDecision("WebFetch", {}, "edit", "/p").allow).toBe(false);
    expect(
      claudeMcpServers(
        [
          {
            name: "m",
            type: "stdio",
            command: "npx",
            args: ["a"],
            envNames: ["K"],
            fixedEnv: { F: "1" },
          },
          { name: "h", type: "http", url: "https://x" },
        ],
        { K: "v" },
      ),
    ).toEqual({
      m: {
        type: "stdio",
        command: "npx",
        args: ["a"],
        env: { F: "1", K: "v" },
      },
      h: { type: "http", url: "https://x" },
    });
  });
});

describe("native connection fallback", () => {
  const ok: Provider = { editsFiles: true, generate: async () => "from cli" };
  const failing = (msg: string, stream = false): Provider => ({
    editsFiles: true,
    generate: async (_r, onDelta) => {
      if (stream) onDelta("partial");
      throw new Error(msg);
    },
  });
  const req = { system: "", prompt: "", cwd: "/p", mode: "edit" as const };

  it("falls back when the native mode can't start, and remembers it", async () => {
    let calls = 0;
    const primary: Provider = {
      editsFiles: true,
      generate: async () => (
        calls++,
        Promise.reject(new Error("unexpected argument 'app-server' found"))
      ),
    };
    const p = new FallbackProvider(primary, ok);
    expect(await p.generate(req, () => {}, AbortSignal.timeout(1000))).toBe(
      "from cli",
    );
    expect(await p.generate(req, () => {}, AbortSignal.timeout(1000))).toBe(
      "from cli",
    );
    expect(calls).toBe(1);
  });

  it("never falls back for sign-in or limits, or after output streamed", async () => {
    for (const p of [
      new FallbackProvider(
        failing("Codex isn't signed in. Run `codex login`"),
        ok,
      ),
      new FallbackProvider(failing("429 rate limit"), ok),
      new FallbackProvider(failing("broke mid-way", true), ok),
    ])
      await expect(
        p.generate(req, () => {}, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
  });
});
