import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { ConfigStore, type Connection } from "../server/config.js";
import { captureBaseline, diffChanges } from "../server/crew/diff.js";
import {
  assignRoles,
  runCrew,
  scheduleTasks,
  type ResolvedMember,
} from "../server/crew/orchestrator.js";
import {
  extractJson,
  parseFileOps,
  parsePlan,
  parseReview,
} from "../server/crew/parse.js";
import {
  buildCliArgs,
  CLI_SPECS,
  parseClaudeStreamLine,
  parseCmdShim,
  parseOpenCodeLine,
  type CliKind,
} from "../server/providers/cli.js";
import {
  isLimitError,
  limitCooldownMs,
  type GenerateRequest,
  type Provider,
} from "../server/providers/types.js";
import { RunManager } from "../server/runs.js";
import { enabledPlugins, PLUGINS } from "../server/plugins.js";
import { selectPacks, SKILL_PACKS } from "../server/skills.js";
import { recordRun } from "../server/graph.js";
import { connectionName } from "../server/shared.js";
import {
  codexMcpArgs,
  HarnessSync,
  ProjectMemory,
  renderBlock,
  upsertBlock,
} from "../server/sync.js";
import type { PlanTask, RunEvent, Settings } from "../server/shared.js";
import { makeProtector } from "../server/guard.js";
import { autoCrew } from "../server/autocrew.js";
import {
  autoTeam,
  modelStrength,
  parseTeam,
  soloMember,
} from "../server/team.js";
import { safeRelative, Workspace } from "../server/workspace.js";

describe("parsers", () => {
  it("parses file blocks, fences and deletes", () => {
    const ops = parseFileOps(
      'Sure!\n<file path="index.html">\n```html\n<h1>Hi</h1>\n```\n</file>\n<file path=\'src/a.js\'>\nlet a = 1;</file><delete path="old.css"/>',
    );
    expect(ops).toEqual([
      { path: "index.html", change: "write", content: "<h1>Hi</h1>\n" },
      { path: "src/a.js", change: "write", content: "let a = 1;\n" },
      { path: "old.css", change: "delete" },
    ]);
  });

  it("extracts JSON with braces inside strings", () => {
    expect(
      extractJson('Plan:\n```json\n{"summary":"use {x}","tasks":[]}\n```'),
    ).toEqual({ summary: "use {x}", tasks: [] });
    expect(extractJson('noise {"a": "}"} tail')).toEqual({ a: "}" });
    expect(extractJson("nothing here")).toBeUndefined();
  });

  it("falls back to a single task when the plan is unusable", () => {
    const plan = parsePlan("I think we should…", "make a todo app");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.description).toBe("make a todo app");
  });

  it("reads review verdicts", () => {
    expect(
      parseReview(
        '{"approved":false,"summary":"bug","issues":[{"file":"a.js","problem":"x","fix":"y"}]}',
      ).approved,
    ).toBe(false);
    expect(parseReview('{"summary":"fine","issues":[]}').approved).toBe(true);
    expect(parseReview("no json").approved).toBe(true);
  });
});

describe("workspace safety", () => {
  it("rejects escaping and protected paths", () => {
    for (const bad of [
      "../x",
      "/etc/passwd",
      "C:/win",
      "a/../../b",
      ".git/config",
      "node_modules/x/y.js",
      "",
    ])
      expect(() => safeRelative(bad)).toThrow();
    expect(safeRelative("./src\\app.js")).toBe("src/app.js");
  });
});

describe("cli adapters", () => {
  const req: GenerateRequest = {
    system: "",
    prompt: "",
    cwd: "/p",
    mode: "edit",
    model: "m",
  };
  it("never uses blanket permission bypass flags", () => {
    for (const kind of Object.keys(CLI_SPECS) as CliKind[]) {
      for (const mode of ["text", "edit"] as const) {
        const args = buildCliArgs(kind, { ...req, mode }, "do it");
        expect(args.join(" ")).not.toMatch(/dangerously|yolo|bypass/i);
        expect(args).not.toContain("--auto");
        expect(args).not.toContain("-y");
      }
    }
    expect(buildCliArgs("opencode-cli", { ...req, mode: "text" }, "x")).toEqual(
      expect.arrayContaining(["--agent", "plan", "--dir", "/p"]),
    );
    expect(buildCliArgs("qwen-cli", { ...req, mode: "text" }, "x")).toEqual(
      expect.arrayContaining(["--approval-mode", "plan"]),
    );
    const ocEnv = JSON.parse(
      CLI_SPECS["opencode-cli"].env!(req).OPENCODE_CONFIG_CONTENT!,
    );
    expect(ocEnv.permission.bash).toBe("deny");
    expect(buildCliArgs("codex-cli", { ...req, mode: "text" }, "x")).toContain(
      "read-only",
    );
    expect(buildCliArgs("claude-cli", { ...req, mode: "text" }, "x")).toContain(
      "plan",
    );
  });
  it("finds the script inside a Windows npm .cmd shim", () => {
    const shim = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    ].join("\r\n");
    expect(parseCmdShim(shim)).toBe(
      "node_modules/@anthropic-ai/claude-code/cli.js",
    );
    expect(parseCmdShim("@echo hello")).toBeUndefined();
  });
  it("parses Claude Code stream-json", () => {
    expect(
      parseClaudeStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      ),
    ).toEqual({ text: "hi" });
    expect(
      parseClaudeStreamLine(
        '{"type":"result","is_error":false,"result":"done"}',
      ),
    ).toEqual({ result: "done" });
    expect(parseClaudeStreamLine("garbage")).toEqual({});
  });
  it("parses OpenCode json events", () => {
    expect(
      parseOpenCodeLine('{"type":"text","part":{"type":"text","text":"done"}}'),
    ).toEqual({ text: "done" });
    expect(
      parseOpenCodeLine(
        '{"type":"tool_use","part":{"tool":"write","state":{"status":"completed","input":{"filePath":"/p/app.js"}}}}',
      ),
    ).toEqual({ text: "▸ write app.js" });
    expect(
      parseOpenCodeLine(
        '{"type":"error","error":{"name":"APIError","data":{"message":"bad key"}}}',
      ),
    ).toEqual({ error: "bad key" });
    expect(parseOpenCodeLine('{"type":"step_start"}')).toEqual({});
  });
});

describe("scheduler", () => {
  it("runs in parallel but never shares a file between concurrent tasks", async () => {
    const tasks: PlanTask[] = [
      { id: "a", title: "a", description: "", files: ["x.js"] },
      { id: "b", title: "b", description: "", files: ["x.js", "y.js"] },
      { id: "c", title: "c", description: "", files: ["z.js"] },
      { id: "d", title: "d", description: "", files: [] },
    ];
    const active = new Set<string>();
    let maxParallel = 0;
    const order: string[] = [];
    await scheduleTasks(tasks, [1, 2, 3], async (t) => {
      for (const f of t.files) expect(active.has(f)).toBe(false);
      if (!t.files.length) expect(active.size).toBe(0);
      t.files.forEach((f) => active.add(f));
      active.add(`task:${t.id}`);
      maxParallel = Math.max(
        maxParallel,
        [...active].filter((k) => k.startsWith("task:")).length,
      );
      await new Promise((r) => setTimeout(r, 10));
      t.files.forEach((f) => active.delete(f));
      active.delete(`task:${t.id}`);
      order.push(t.id);
    });
    expect(order.sort()).toEqual(["a", "b", "c", "d"]);
    expect(maxParallel).toBeGreaterThan(1);
  });
});

/** Scripted provider: answers by role, inferred from the system prompt. */
function fakeProvider(script: { review: string[] }): Provider {
  let reviews = 0;
  return {
    editsFiles: false,
    async generate(req, onDelta) {
      let out: string;
      if (req.system.includes("ARCHITECT"))
        out = JSON.stringify({
          summary: "Two files.",
          tasks: [
            {
              title: "Page",
              description: "html",
              files: ["index.html"],
              assignee: "b2",
              why: "markup",
            },
            {
              title: "Logic",
              description: "js",
              files: ["app.js"],
              assignee: "b1",
              why: "logic",
            },
          ],
        });
      else if (req.system.includes("REVIEWER"))
        out =
          script.review[reviews++] ??
          '{"approved":true,"summary":"ok","issues":[]}';
      else if (req.prompt.includes("YOUR TASK: Page"))
        out =
          '<file path="index.html">\n<script src="app.js"></script>\n</file>';
      else if (req.prompt.includes("YOUR TASK: Logic"))
        out = '<file path="app.js">\nconsole.log(1)\n</file>';
      else out = '<file path="app.js">\nconsole.log("fixed")\n</file>';
      onDelta(out);
      return out;
    },
  };
}

const conn = (id: string): Connection => ({
  id,
  kind: "openai-compatible",
  label: id,
  baseUrl: "http://x",
});
const member = (
  id: string,
  role: ResolvedMember["role"],
  provider: Provider,
): ResolvedMember => ({
  id,
  name: id,
  role,
  connectionId: id,
  connection: conn(id),
  provider,
});

describe("crew orchestration", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("fills missing roles from a single connection", () => {
    const p = fakeProvider({ review: [] });
    const roles = assignRoles([member("solo", "builder", p)]);
    expect(roles.architect.id).toBe("solo");
    expect(roles.reviewer.id).toBe("solo");
  });

  it("plans, builds in parallel, reviews, fixes and re-reviews", async () => {
    const ws = await Workspace.open(dir, "demo");
    const p = fakeProvider({
      review: [
        '{"approved":false,"summary":"bug","issues":[{"file":"app.js","problem":"logs 1","fix":"log fixed"}]}',
      ],
    });
    const events: RunEvent[] = [];
    const result = await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([
        member("arch", "architect", p),
        member("b1", "builder", p),
        member("b2", "builder", p),
        member("rev", "reviewer", p),
      ]),
      settings: { maxReviewRounds: 2, dispatch: "smart" },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    expect(result.changedFiles).toEqual(["app.js", "index.html"]);
    expect(await ws.read("app.js")).toBe('console.log("fixed")\n');
    expect(events.filter((e) => e.type === "review")).toHaveLength(2);
    const ran = (id: string) =>
      events.find(
        (e) =>
          e.type === "task.status" && e.taskId === id && e.status === "running",
      );
    // The dispatcher's picks are honoured.
    expect(ran("t1")).toMatchObject({ memberId: "b2" });
    expect(ran("t2")).toMatchObject({ memberId: "b1" });
    // The review fix goes back to the agent that wrote app.js.
    expect(ran("r1-1")).toMatchObject({ memberId: "b1" });
    expect(result.checkpoint.files.map((f) => f.path)).toEqual([
      "app.js",
      "index.html",
    ]);
  });
});

describe("team choice", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-team-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("a single model still plans, builds and reviews its own work", async () => {
    const ws = await Workspace.open(dir, "solo");
    const p = fakeProvider({ review: [] });
    const events: RunEvent[] = [];
    const solo = soloMember({
      id: "one",
      kind: "openai-compatible",
      label: "one",
      baseUrl: "http://x",
    });
    const result = await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([{ ...solo, connection: conn("one"), provider: p }]),
      settings: { maxReviewRounds: 1, dispatch: "smart" },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    expect(result.changedFiles).toEqual(["app.js", "index.html"]);
    expect(
      events.some((e) => e.type === "phase" && e.phase === "planning"),
    ).toBe(true);
    expect(events.filter((e) => e.type === "review")).toHaveLength(1);
    // Every step ran on the one model.
    const who = new Set(
      events.flatMap((e) =>
        e.type === "task.status" && e.memberId ? [e.memberId] : [],
      ),
    );
    expect([...who]).toEqual(["solo-one"]);
  });

  it("auto ranks models: the strongest plans, the next reviews, the rest build", () => {
    const c = (
      id: string,
      kind: Connection["kind"],
      defaultModel?: string,
    ): Connection => ({ id, kind, label: id, defaultModel });
    const team = autoTeam([
      c("free", "opencode-cli", "opencode/big-pickle"),
      c("mid", "openai-compatible", "deepseek-chat"),
      c("top", "claude-cli", "claude-opus-5-5"),
      c("gpt", "codex-cli", "gpt-5"),
    ]);
    expect(team.map((m) => [m.connectionId, m.role])).toEqual([
      ["top", "architect"],
      ["gpt", "reviewer"],
      ["mid", "builder"],
      ["free", "builder"],
    ]);
    expect(
      autoTeam([c("a", "gemini-cli"), c("b", "claude-cli")]).map((m) => [
        m.connectionId,
        m.role,
      ]),
    ).toEqual([
      ["b", "architect"],
      ["a", "builder"],
    ]);
    expect(modelStrength("openai", "gpt-5-mini")).toBe(1);
    expect(modelStrength("anthropic", "claude-sonnet-4-5")).toBe(2);
    expect(
      modelStrength("openai-compatible", "openrouter/some-new-model"),
    ).toBe(2);
  });

  it("validates the team in a request", () => {
    const known = (id: string) =>
      id === "c1"
        ? ({ id, kind: "openai", label: "x" } as Connection)
        : undefined;
    expect(parseTeam(undefined, known)).toEqual({ kind: "crew" });
    expect(parseTeam({ kind: "auto" }, known)).toEqual({ kind: "auto" });
    expect(
      parseTeam({ kind: "solo", connectionId: "c1", model: " gpt-5 " }, known),
    ).toEqual({ kind: "solo", connectionId: "c1", model: "gpt-5" });
    expect(() =>
      parseTeam({ kind: "solo", connectionId: "nope" }, known),
    ).toThrow();
    expect(() => parseTeam({ kind: "everyone" }, known)).toThrow();
    expect(
      soloMember(
        { id: "c1", kind: "claude-cli", label: "Claude Code" },
        "claude-opus-5-5",
      ),
    ).toMatchObject({ name: "Claude Opus 5.5", role: "builder" });
  });
});

describe("http guards", () => {
  let base: string;
  let close: () => void;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-http-"));
    const config = new ConfigStore(dir);
    await config.load();
    const { app } = createApp({
      config,
      projectsDir: path.join(dir, "projects"),
      providerFactory: () => fakeProvider({ review: [] }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(async () => {
    close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects mutations without the CSRF header", async () => {
    const r = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"x"}',
    });
    expect(r.status).toBe(403);
  });

  it("never returns API keys", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    const created = await fetch(`${base}/api/connections`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ kind: "anthropic", apiKey: "sk-secret-1234" }),
    });
    expect(created.status).toBe(201);
    const state = await (await fetch(`${base}/api/state`)).text();
    expect(state).not.toContain("sk-secret");
    expect(state).toContain("…1234");
  });

  it("runs a crew end to end over HTTP + SSE", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: h,
      body: '{"name":"site"}',
    });
    const run = await (
      await fetch(`${base}/api/projects/site/runs`, {
        method: "POST",
        headers: h,
        body: '{"prompt":"build"}',
      })
    ).json();
    const res = await fetch(`${base}/api/runs/${run.id}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("run.done") && !text.includes("run.error"))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("run.done");
    const preview = await fetch(`${base}/preview/site/`);
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(await preview.text()).toContain("app.js");
  });
});

describe("diffs", () => {
  it("reports added, modified and deleted files with line counts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-diff-"));
    try {
      const ws = await Workspace.open(dir, "d");
      await ws.write("keep.js", "a\nb\nc\n");
      await ws.write("gone.js", "x\n");
      const base = await captureBaseline(ws);
      await ws.write("keep.js", "a\nB\nc\nd\n");
      await ws.remove("gone.js");
      await ws.write("new.js", "n1\nn2\n");
      const diffs = await diffChanges(ws, base, [
        "keep.js",
        "gone.js",
        "new.js",
      ]);
      expect(
        diffs.map((d) => [d.path, d.change, d.additions, d.deletions]),
      ).toEqual([
        ["gone.js", "deleted", 0, 1],
        ["keep.js", "modified", 2, 1],
        ["new.js", "added", 2, 0],
      ]);
      expect(diffs[1]!.hunks[0]!.lines).toContain("+B");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run history", () => {
  it("survives a restart and closes runs that were interrupted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-runs-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.upsertConnection({
        kind: "openai-compatible",
        baseUrl: "http://x",
        defaultModel: "m",
      });
      const runsDir = path.join(dir, "runs");
      const factory = () => fakeProvider({ review: [] });
      const first = new RunManager(
        config,
        path.join(dir, "projects"),
        factory,
        runsDir,
      );
      await first.load();
      const run = await first.start("p1", "make a page");
      await new Promise<void>((resolve) => {
        const off = first.subscribe(run.id, (e) => {
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      await new Promise((r) => setTimeout(r, 50)); // let the log stream flush

      // A run that was still "running" when the process died.
      const ghost = "00000000-0000-4000-8000-000000000000";
      await writeFile(
        path.join(runsDir, `${ghost}.json`),
        JSON.stringify({
          id: ghost,
          project: "p1",
          prompt: "old",
          status: "running",
          startedAt: 1,
        }),
      );

      const second = new RunManager(
        config,
        path.join(dir, "projects"),
        factory,
        runsDir,
      );
      await second.load();
      const list = second.list("p1");
      expect(list.find((r) => r.id === run.id)?.status).toBe("done");
      expect(list.find((r) => r.id === ghost)?.status).toBe("error");
      const types = (await second.events(run.id)).map((e) => e.type);
      expect(types[0]).toBe("run.started");
      expect(types).toContain("run.diff");
      expect(types.at(-1)).toBe("run.done");
      expect((await second.events(ghost)).at(-1)?.type).toBe("run.error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch and member agents", () => {
  it("routes assigned tasks to their member and runs a member's agents in parallel", async () => {
    const tasks: PlanTask[] = [
      { id: "a", title: "a", description: "", files: ["a.js"], assignee: "m1" },
      { id: "b", title: "b", description: "", files: ["b.js"], assignee: "m1" },
      { id: "c", title: "c", description: "", files: ["c.js"], assignee: "m2" },
    ];
    const m1 = { id: "m1" };
    const m2 = { id: "m2" };
    const who: Record<string, string> = {};
    let live = 0;
    let peakM1 = 0;
    await scheduleTasks(
      tasks,
      [m1, m1, m2], // m1 has two agents
      async (t, w) => {
        who[t.id] = w.id;
        if (w.id === "m1") peakM1 = Math.max(peakM1, ++live);
        await new Promise((r) => setTimeout(r, 15));
        if (w.id === "m1") live--;
      },
      (t, w) => !t.assignee || t.assignee === w.id,
    );
    expect(who).toEqual({ a: "m1", b: "m1", c: "m2" });
    expect(peakM1).toBe(2);
  });
});

describe("harness sync", () => {
  it("manages only its own block and MCP entries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-sync-"));
    try {
      const ws = await Workspace.open(dir, "s");
      await ws.write("CLAUDE.md", "# My notes\nkeep me\n");
      await ws.write(
        ".mcp.json",
        JSON.stringify({ mcpServers: { mine: { command: "x" } } }),
      );
      const memory = new ProjectMemory(path.join(dir, "mem"));
      await memory.add("s", {
        at: Date.UTC(2026, 10, 24),
        prompt: "make a timer",
        summary: "built it",
      });
      const sync = new HarnessSync(path.join(dir, "state"), memory);
      const cfg = {
        instructions: "Use TypeScript.",
        mcpServers: [
          {
            name: "docs",
            type: "stdio" as const,
            command: "npx",
            args: ["-y", "docs-mcp"],
            envNames: ["DOCS_TOKEN"],
          },
        ],
        env: { DOCS_TOKEN: "secret-value" },
      };
      await sync.apply("s", ws, cfg);

      const claude = await ws.read("CLAUDE.md");
      expect(claude).toContain("keep me");
      expect(claude).toContain("Use TypeScript.");
      expect(claude).toContain("make a timer → built it");
      for (const f of ["AGENTS.md", "GEMINI.md", "QWEN.md"])
        expect(await ws.read(f)).toContain("Use TypeScript.");
      const mcp = JSON.parse(await ws.read(".mcp.json"));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(["docs", "mine"]);
      expect(mcp.mcpServers.docs.env.DOCS_TOKEN).toBe("${DOCS_TOKEN}");
      expect(
        JSON.parse(await ws.read("opencode.json")).mcp.docs.command,
      ).toEqual(["npx", "-y", "docs-mcp"]);
      expect(
        JSON.parse(await ws.read(".gemini/settings.json")).mcpServers.docs.env
          .DOCS_TOKEN,
      ).toBe("$DOCS_TOKEN");
      // Secrets never reach project files.
      for (const f of await ws.list())
        expect(await ws.read(f)).not.toContain("secret-value");

      // Removing everything cleans up after itself but keeps the user's content.
      await sync.apply("s", ws, { instructions: "", mcpServers: [], env: {} });
      await new ProjectMemory(path.join(dir, "mem")); // memory stays, so the block stays with memory only
      expect(await ws.read("CLAUDE.md")).toContain("keep me");
      expect(await ws.read("CLAUDE.md")).not.toContain("Use TypeScript.");
      expect(JSON.parse(await ws.read(".mcp.json")).mcpServers).toEqual({
        mine: { command: "x" },
      });
      expect(await ws.tryRead("opencode.json")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps user files intact when the block is removed", () => {
    const withBlock = upsertBlock("Hello\n", renderBlock("Rule", []));
    expect(withBlock).toContain("Rule");
    expect(upsertBlock(withBlock, "")).toBe("Hello\n");
  });

  it("passes MCP servers to Codex without secrets on the command line", () => {
    const args = codexMcpArgs([
      {
        name: "docs",
        type: "stdio",
        command: "npx",
        args: ["-y", "d"],
        envNames: ["TOKEN"],
      },
    ]);
    expect(args).toEqual([
      "-c",
      'mcp_servers.docs.command="npx"',
      "-c",
      'mcp_servers.docs.args=["-y","d"]',
      "-c",
      'mcp_servers.docs.env_vars=["TOKEN"]',
    ]);
  });
});

describe("undo", () => {
  it("restores a run's files and refuses when they changed since", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-undo-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.upsertConnection({
        kind: "openai-compatible",
        baseUrl: "http://x",
        defaultModel: "m",
      });
      const projects = path.join(dir, "projects");
      const ws = await Workspace.open(projects, "u");
      await ws.write("index.html", "original\n");
      const runs = new RunManager(
        config,
        projects,
        () => fakeProvider({ review: [] }),
        path.join(dir, "runs"),
      );
      const finished = async () => {
        const r = await runs.start("u", "go");
        await new Promise<void>((resolve) => {
          const off = runs.subscribe(r.id, (e) => {
            if (e.type === "run.done" || e.type === "run.error") {
              off();
              resolve();
            }
          });
        });
        return r.id;
      };

      const first = await finished();
      expect(await ws.read("index.html")).toContain("app.js");
      await ws.write("index.html", "hand edit\n");
      expect((await runs.undo(first)).conflicts).toEqual(["index.html"]);

      const second = await finished();
      const result = await runs.undo(second);
      expect(result.conflicts).toEqual([]);
      expect(await ws.read("index.html")).toBe("hand edit\n");
      expect(await ws.tryRead("app.js")).toBeDefined(); // existed before the second run (from the first)
      await expect(runs.undo(second)).rejects.toThrow(/already undone/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verification and reassignment", () => {
  it("fails a task whose agent wrote nothing and hands it to another builder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-retry-"));
    try {
      const ws = await Workspace.open(dir, "r");
      const plan = JSON.stringify({
        summary: "s",
        tasks: [
          {
            title: "Logic",
            description: "",
            files: ["app.js"],
            assignee: "lazy",
            why: "fit",
          },
        ],
      });
      const lazy: Provider = {
        editsFiles: false,
        async generate(req) {
          return req.system.includes("ARCHITECT")
            ? plan
            : '<file path="other.txt">\nnot mine\n</file>';
        },
      };
      const good: Provider = {
        editsFiles: false,
        async generate() {
          return '<file path="app.js">\nok()\n</file>';
        },
      };
      const events: RunEvent[] = [];
      await runCrew({
        prompt: "p",
        history: [],
        workspace: ws,
        roles: assignRoles([
          member("arch", "architect", lazy),
          member("lazy", "builder", lazy),
          member("good", "builder", good),
        ]),
        settings: { maxReviewRounds: 0, dispatch: "smart" },
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
      });
      const statuses = events.flatMap((e) =>
        e.type === "task.status" && e.status !== "queued"
          ? [`${e.taskId}:${e.status}:${e.memberId}`]
          : [],
      );
      expect(statuses).toEqual([
        "t1:running:lazy",
        "t1:failed:lazy",
        "t1-retry:running:good",
        "t1-retry:done:good",
      ]);
      expect(await ws.read("app.js")).toBe("ok()\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("watchdog", () => {
  it("stops a silent agent and reassigns its task", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-dog-"));
    try {
      const ws = await Workspace.open(dir, "w");
      const plan = JSON.stringify({
        summary: "s",
        tasks: [
          {
            title: "Logic",
            description: "",
            files: ["app.js"],
            assignee: "stuck",
          },
        ],
      });
      const stuck: Provider = {
        editsFiles: false,
        generate: (req, _d, signal) =>
          req.system.includes("ARCHITECT")
            ? Promise.resolve(plan)
            : new Promise((_r, reject) =>
                signal.addEventListener("abort", () =>
                  reject(new Error("Cancelled")),
                ),
              ),
      };
      const good: Provider = {
        editsFiles: false,
        async generate() {
          return '<file path="app.js">\nok()\n</file>';
        },
      };
      const events: RunEvent[] = [];
      await runCrew({
        prompt: "p",
        history: [],
        workspace: ws,
        roles: assignRoles([
          member("arch", "architect", stuck),
          member("stuck", "builder", stuck),
          member("good", "builder", good),
        ]),
        settings: { maxReviewRounds: 0, dispatch: "smart" },
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        limits: { idleMs: 50, maxMs: 1000 },
      });
      const failed = events.find(
        (e) => e.type === "task.status" && e.status === "failed",
      );
      expect(failed).toMatchObject({ memberId: "stuck" });
      expect((failed as { error: string }).error).toMatch(/went silent/);
      expect(await ws.read("app.js")).toBe("ok()\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("harness names", () => {
  it("names connections after the harness people know", () => {
    expect(connectionName("claude-cli")).toBe("Claude Code");
    expect(connectionName("codex-cli")).toBe("Codex");
    expect(
      connectionName("opencode-cli", undefined, "opencode/big-pickle"),
    ).toBe("Big Pickle (free)");
    expect(connectionName("anthropic", undefined, "claude-opus-5-5")).toBe(
      "Claude Opus 5.5",
    );
    expect(
      connectionName(
        "openai-compatible",
        "https://openrouter.ai/api/v1",
        "openai/gpt-5",
      ),
    ).toBe("GPT-5");
    expect(
      connectionName("openai-compatible", "https://openrouter.ai/api/v1"),
    ).toBe("OpenRouter");
    expect(
      connectionName("openai-compatible", "http://localhost:11434/v1"),
    ).toBe("Ollama");
    expect(
      connectionName("openai-compatible", "https://api.example.dev/v1"),
    ).toBe("api.example.dev");
    expect(
      connectionName("openai-compatible", "http://127.0.0.1:8080/v1"),
    ).toBe("Local server");
  });
});

describe("plugins", () => {
  it("turns on memory and browser by default and guards computer control", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-plug-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      const ids = () =>
        enabledPlugins({
          enabled: config.extensions.pluginsEnabled,
          disabled: config.extensions.pluginsDisabled,
        }).map((p) => p.id);
      expect(ids()).toEqual(["memory-graph", "browser"]);
      await expect(
        config.setExtensions({ plugin: { id: "computer-use", enabled: true } }),
      ).rejects.toThrow(/Confirm the risk/);
      await config.setExtensions({
        plugin: { id: "computer-use", enabled: true, confirmRisk: true },
      });
      await config.setExtensions({ plugin: { id: "browser", enabled: false } });
      expect(ids()).toEqual(["memory-graph", "computer-use"]);

      const ctx = {
        project: "p",
        dataDir: "/data",
        previewOrigin: "http://localhost:4317",
        options: {},
      };
      const browser = PLUGINS.find((p) => p.id === "browser")!.server(ctx);
      expect(browser.args).toContain("--allowed-origins");
      expect(
        PLUGINS.find((p) => p.id === "browser")!.server({
          ...ctx,
          options: { browserAnyWebsite: true },
        }).args,
      ).not.toContain("--allowed-origins");
      const memory = PLUGINS.find((p) => p.id === "memory-graph")!.server(ctx);
      expect(memory.fixedEnv?.MEMORY_FILE_PATH).toBe(
        path.join("/data", "graphs", "p.jsonl"),
      );
      // Every plugin pins an exact version.
      for (const p of PLUGINS)
        expect(
          p
            .server(ctx)
            .args?.find((a) => a.includes("@") && !a.startsWith("-")),
        ).toMatch(/@\d+\.\d+\.\d+$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skill packs", () => {
  it("picks packs from the request and project files", () => {
    const ids = (r: string, f: string[] = [], m = {}) =>
      selectPacks(m, r, f).map((a) => a.pack.id);
    expect(ids("make a landing page")).toEqual(["quality", "web"]);
    expect(ids("build a roblox obby")).toEqual(["quality", "roblox"]);
    expect(ids("refactor", ["src/game.luau"])).toEqual(["quality", "roblox"]);
    expect(ids("anything", [], { quality: "off", python: "on" })).toEqual([
      "python",
    ]);
  });

  it("writes skills for every harness, keeps the user's own, and cleans up", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-skill-"));
    try {
      const ws = await Workspace.open(dir, "s");
      await ws.write(".claude/skills/self-review/SKILL.md", "my own version\n");
      const sync = new HarnessSync(
        path.join(dir, "state"),
        new ProjectMemory(path.join(dir, "mem")),
      );
      const skills = SKILL_PACKS.find((p) => p.id === "quality")!.skills;
      const cfg = { instructions: "", mcpServers: [], env: {} };
      await sync.apply("s", ws, cfg, { servers: [], instructions: [], skills });
      for (const d of [".agents", ".gemini", ".qwen"])
        expect(await ws.read(`${d}/skills/secure-coding/SKILL.md`)).toMatch(
          /^---\nname: secure-coding\n/,
        );
      expect(await ws.read(".claude/skills/self-review/SKILL.md")).toBe(
        "my own version\n",
      );
      await sync.apply("s", ws, cfg, {
        servers: [],
        instructions: [],
        skills: [],
      });
      expect(
        await ws.tryRead(".agents/skills/secure-coding/SKILL.md"),
      ).toBeUndefined();
      expect(await ws.read(".claude/skills/self-review/SKILL.md")).toBe(
        "my own version\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("memory graph", () => {
  it("records a run in the memory server's JSONL format", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-graph-"));
    try {
      const file = path.join(dir, "g.jsonl");
      const rec = {
        project: "p",
        prompt: "add login",
        summary: "done",
        files: ["auth.js"],
        agents: [{ name: "Codex", harness: "Codex", files: ["auth.js"] }],
        at: Date.UTC(2026, 10, 24),
      };
      await recordRun(file, rec);
      await recordRun(file, rec); // idempotent for identical facts
      const lines = (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toContainEqual({
        type: "entity",
        name: "project:p",
        entityType: "project",
        observations: ['2026-11-24: "add login" → done'],
      });
      expect(lines).toContainEqual({
        type: "relation",
        from: "agent:Codex",
        to: "file:auth.js",
        relationType: "edited",
      });
      expect(lines.filter((l) => l.type === "relation")).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("free fallback", () => {
  it("moves work to the free model when an account hits its limit, and keeps it there", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-fb-"));
    try {
      const ws = await Workspace.open(dir, "f");
      const plan = JSON.stringify({
        summary: "s",
        tasks: [
          { title: "A", description: "", files: ["a.js"] },
          { title: "B", description: "", files: ["b.js"] },
        ],
      });
      let paidCalls = 0;
      const paid: Provider = {
        editsFiles: false,
        async generate(req) {
          paidCalls++;
          if (req.system.includes("ARCHITECT")) return plan;
          throw new Error("Claude AI usage limit reached. Try again in 2h");
        },
      };
      const free: Provider = {
        editsFiles: false,
        async generate(req) {
          req.onUsage?.({ input: 100, output: 50 });
          const f = req.prompt.includes("YOUR TASK: A") ? "a.js" : "b.js";
          return `<file path="${f}">\nok\n</file>`;
        },
      };
      const fallback = {
        ...member("free-fallback", "builder", free),
        name: "Free",
        connection: {
          id: "free-fallback",
          kind: "openai-compatible" as const,
          label: "Free",
          baseUrl: "http://localhost:11434/v1",
        },
      };
      const events: RunEvent[] = [];
      const limited = new Map<string, number>();
      await runCrew({
        prompt: "p",
        history: [],
        workspace: ws,
        roles: assignRoles([member("paid", "builder", paid)]),
        settings: {
          maxReviewRounds: 0,
          dispatch: "smart",
          safety: "direct",
          protectedPaths: [],
          economy: false,
          freeFallback: { enabled: true, model: "x" },
        },
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        fallback,
        limited,
      });
      expect(await ws.read("a.js")).toBe("ok\n");
      expect(await ws.read("b.js")).toBe("ok\n");
      const limit = events.find((e) => e.type === "member.limit");
      expect(limit).toMatchObject({ memberId: "paid", fallback: "Free" });
      expect((limit as { until: number }).until - Date.now()).toBeGreaterThan(
        1.9 * 3600_000,
      );
      // Planning (1) + the first build attempt (1); the second task goes straight to the fallback.
      expect(paidCalls).toBe(2);
      expect(events.filter((e) => e.type === "usage" && e.free)).toHaveLength(
        2,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies limit errors and their cooldowns", () => {
    expect(isLimitError("You've hit your usage limit")).toBe(true);
    expect(isLimitError("429 Too Many Requests")).toBe(true);
    expect(isLimitError("SyntaxError: unexpected token")).toBe(false);
    expect(limitCooldownMs("try again in 37 minutes")).toBe(37 * 60_000);
    expect(limitCooldownMs("insufficient_quota")).toBe(3600_000);
    expect(limitCooldownMs("overloaded")).toBe(120_000);
  });
});

describe("file safety", () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({
    maxReviewRounds: 0,
    dispatch: "smart",
    safety: "direct",
    protectedPaths: [".env", "*.pem"],
    economy: false,
    freeFallback: { enabled: false, model: "" },
    ...over,
  });

  it("never sends or lets agents change protected files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-prot-"));
    try {
      const ws = await Workspace.open(dir, "p");
      await ws.write(".env", "SECRET=1\n");
      let sawSecret = false;
      const sneaky: Provider = {
        editsFiles: false,
        async generate(req) {
          if (req.prompt.includes("SECRET=1")) sawSecret = true;
          if (req.system.includes("ARCHITECT"))
            return JSON.stringify({
              summary: "s",
              tasks: [{ title: "T", description: "", files: ["app.js"] }],
            });
          return '<file path="app.js">\nx\n</file><file path=".env">\nSECRET=stolen\n</file><file path="cert.pem">\nk\n</file>';
        },
      };
      const events: RunEvent[] = [];
      const result = await runCrew({
        prompt: "p",
        history: [],
        workspace: ws,
        roles: assignRoles([member("b", "builder", sneaky)]),
        settings: settings(),
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        isProtected: makeProtector([".env", "*.pem"]),
      });
      expect(sawSecret).toBe(false);
      expect(await ws.read(".env")).toBe("SECRET=1\n");
      expect(await ws.tryRead("cert.pem")).toBeUndefined();
      expect(result.changedFiles).toEqual(["app.js"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches globs on paths and file names", () => {
    const p = makeProtector([".env.*", "secrets/**", "**/id_rsa*"]);
    expect(p(".env.local")).toBe(true);
    expect(p("secrets/a/b.txt")).toBe(true);
    expect(p("home/.ssh/id_rsa.pub")).toBe(true);
    expect(p("src/env.ts")).toBe(false);
  });

  it("plans without touching files in read-only mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-ro-"));
    try {
      const ws = await Workspace.open(dir, "r");
      const p = fakeProvider({ review: [] });
      const result = await runCrew({
        prompt: "make a page",
        history: [],
        workspace: ws,
        roles: assignRoles([member("b", "builder", p)]),
        settings: settings({ safety: "readonly" }),
        emit: () => {},
        signal: new AbortController().signal,
      });
      expect(result.changedFiles).toEqual([]);
      expect(result.summary).toMatch(/1\. Page/);
      expect(await ws.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sandbox and MultiDesign", () => {
  const setup = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-sb-"));
    const config = new ConfigStore(dir);
    await config.load();
    const c1 = await config.upsertConnection({
      kind: "openai-compatible",
      baseUrl: "http://x",
      defaultModel: "m",
    });
    const c2 = await config.upsertConnection({
      kind: "openai-compatible",
      baseUrl: "http://y",
      defaultModel: "m",
    });
    await config.setSettings({ maxReviewRounds: 0 });
    await config.setSettings({ freeFallback: { enabled: false } });
    const memory = new ProjectMemory(path.join(dir, "memory"));
    const runs = new RunManager(
      config,
      path.join(dir, "projects"),
      () => fakeProvider({ review: [] }),
      path.join(dir, "runs"),
      {
        harness: new HarnessSync(path.join(dir, "sync"), memory),
        memory,
        dataDir: dir,
        previewOrigin: "http://localhost:1",
      },
    );
    const finished = async (
      prompt: string,
      mode: "build" | "design" = "build",
    ) => {
      const r = await runs.start("site", prompt, mode);
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      return runs.get(r.id);
    };
    return {
      dir,
      config,
      runs,
      finished,
      ws: await Workspace.open(path.join(dir, "projects"), "site"),
      ids: [c1.id, c2.id],
    };
  };

  it("keeps the project untouched until you apply a sandbox run", async () => {
    const { dir, config, runs, finished, ws } = await setup();
    try {
      await config.setSettings({ safety: "sandbox" });
      await ws.write(".env", "S=1\n");
      const run = await finished("make a page");
      expect(run.pending).toBe("sandbox");
      expect(await ws.tryRead("index.html")).toBeUndefined();
      const result = await runs.apply(run.id);
      expect(result.applied.sort()).toEqual(["app.js", "index.html"]);
      expect(await ws.read("index.html")).toContain("app.js");
      expect(await ws.read(".env")).toBe("S=1\n");
      expect(runs.get(run.id).canUndo).toBe(true);
      await runs.undo(run.id);
      expect(await ws.tryRead("index.html")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds design variants side by side and applies the one you pick", async () => {
    const { dir, runs, finished, ws } = await setup();
    try {
      const run = await finished("a timer", "design");
      expect(run.pending).toBe("design");
      const events = await runs.events(run.id);
      const variants = events.find((e) => e.type === "variants");
      expect((variants as { variants: unknown[] }).variants).toHaveLength(2);
      await expect(runs.apply(run.id, "nope")).rejects.toThrow(/pick one/);
      await runs.apply(run.id, "v2");
      expect(await ws.tryRead("app.js")).toBeDefined();
      expect(runs.get(run.id)).toMatchObject({ resolution: "applied" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("auto crew from one key", () => {
  it("uses free models to plan and review and the Auto Router to build", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-x",
              context_length: 200000,
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            {
              id: "deepseek/deepseek-chat:free",
              context_length: 160000,
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "qwen/qwen-coder:free",
              context_length: 260000,
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        }),
      )) as typeof fetch;
    const crew = await autoCrew(
      {
        id: "c",
        kind: "openai-compatible",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "k",
      },
      fakeFetch,
    );
    expect(crew.map((m) => [m.role, m.model])).toEqual([
      ["architect", "qwen/qwen-coder:free"],
      ["builder", "openrouter/auto"],
      ["reviewer", "deepseek/deepseek-chat:free"],
    ]);
  });
});
