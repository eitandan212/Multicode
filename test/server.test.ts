import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { ConfigStore, parseHeaders, type Connection } from "../server/config.js";
import { captureBaseline, diffChanges } from "../server/crew/diff.js";
import {
  assignRoles,
  runCrew,
  smallTalkReply,
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
  resolveLaunch,
  parseOpenCodeLine,
  type CliKind,
} from "../server/providers/cli.js";
import {
  isLimitError,
  limitCooldownMs,
  type GenerateRequest,
  type Provider,
} from "../server/providers/types.js";
import { readMentions, RunManager } from "../server/runs.js";
import { Approvals } from "../server/approvals.js";
import { linkProject, listProjects, setProjectEmoji, unlinkProject, validateEmoji } from "../server/workspace.js";
import { homedir } from "node:os";
import { enabledPlugins, PLUGINS } from "../server/plugins.js";
import { selectPacks, SKILL_PACKS } from "../server/skills.js";
import { recordRun } from "../server/graph.js";
import { connectionName, contextWindow } from "../server/shared.js";
import { costTier } from "../server/crew/prompts.js";
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
import { AGENT_PRESETS } from "../server/agents.js";
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

  it("builds nothing on a guess when the architect answers in prose", () => {
    const plan = parsePlan("What should the app do?", "make something");
    expect(plan.tasks).toEqual([]);
    expect(plan.reply).toBe("What should the app do?");
  });

  it("falls back to a single task when a JSON plan has no usable tasks", () => {
    const plan = parsePlan('{"summary":"todo app","tasks":[{"title":""}]}', "make a todo app");
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
    // OpenCode 2: no --dir, a private server, edits approved only in edit tasks.
    const v2edit = buildCliArgs(
      "opencode-cli",
      { ...req, mode: "edit" },
      "x",
      2,
    );
    expect(v2edit).toEqual(
      expect.arrayContaining(["--standalone", "--agent", "build", "--auto"]),
    );
    expect(v2edit).not.toContain("--dir");
    expect(
      buildCliArgs("opencode-cli", { ...req, mode: "text" }, "x", 2),
    ).not.toContain("--auto");
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
  it("launches npx.cmd through node and npm's own script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-shim-"));
    try {
      await mkdir(path.join(dir, "node_modules", "npm", "bin"), { recursive: true });
      await writeFile(path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), "");
      // A format this version has never seen: found by its standard location instead.
      await writeFile(path.join(dir, "npx.cmd"), "@ECHO OFF\r\nnode something-new %*");
      const l = await resolveLaunch(path.join(dir, "npx.cmd"));
      expect(l.prefix[0]).toBe(path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"));
      expect(path.basename(l.command)).toMatch(/^node|electron/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reads npm's own npm.cmd and npx.cmd (Node for Windows)", () => {
    const npx = [
      ":: Created by npm, please don't edit manually.",
      "@ECHO OFF",
      "SETLOCAL",
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'IF NOT EXIST "%NODE_EXE%" (',
      '  SET "NODE_EXE=node"',
      ")",
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
      "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (",
      '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
      ")",
      '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
    ].join("\r\n");
    expect(parseCmdShim(npx)).toBe("node_modules/npm/bin/npx-cli.js");
    expect(parseCmdShim(npx.replace(/NPX_CLI_JS/g, "NPM_CLI_JS").replace(/npx-cli/g, "npm-cli"))).toBe(
      "node_modules/npm/bin/npm-cli.js",
    );
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

describe("approvals (as in Claude Code)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-approve-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** A run whose approvals are answered by `answer` as they come in. */
  const runWith = async (
    project: string,
    mode: "ask" | "edits" | "all",
    answer: (e: Extract<RunEvent, { type: "approval.request" }>) => boolean,
    builder: ResolvedMember,
  ) => {
    const ws = await Workspace.open(dir, project);
    const asked: Extract<RunEvent, { type: "approval.request" }>[] = [];
    let approvals!: Approvals;
    const emit = (e: RunEvent) => {
      if (e.type === "approval.request") {
        asked.push(e);
        queueMicrotask(() => approvals.resolve(e.id, answer(e)));
      }
    };
    approvals = new Approvals(mode, emit);
    const result = await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([builder]),
      settings: { maxReviewRounds: 0 },
      emit,
      signal: new AbortController().signal,
      approvals,
    });
    return { ws, asked, result };
  };

  it("asks before an API model's files are written, and writes nothing on no", async () => {
    const no = await runWith("api-no", "ask", () => false, member("m", "builder", fakeProvider({ review: [] })));
    expect(no.asked.map((a) => a.kind)).toEqual(["edit", "edit"]);
    expect(no.asked[0]!.files?.length).toBe(1);
    expect(no.asked[0]!.detail).toContain("+");
    expect(no.result.changedFiles).toEqual([]);
    expect(no.result.summary).toMatch(/declined/);
    expect(await no.ws.tryRead("index.html")).toBeUndefined();

    const yes = await runWith("api-yes", "ask", () => true, member("m", "builder", fakeProvider({ review: [] })));
    expect(yes.result.changedFiles).toEqual(["app.js", "index.html"]);
  });

  it("doesn't ask for edits in auto-accept or approve-all mode", async () => {
    for (const mode of ["edits", "all"] as const) {
      const r = await runWith(`api-${mode}`, mode, () => false, member("m", "builder", fakeProvider({ review: [] })));
      expect(r.asked).toEqual([]);
      expect(r.result.changedFiles.length).toBe(2);
    }
  });

  it("shows an agent's own edits after the fact and reverts them on no", async () => {
    // An agent that edits files itself (like OpenCode's CLI) and can't be paused first.
    const agent: Provider = {
      editsFiles: true,
      async generate(req) {
        if (req.system.includes("ARCHITECT"))
          return '{"summary":"s","tasks":[{"title":"Page","description":"d","files":["index.html"]}]}';
        await writeFile(path.join(req.cwd, "index.html"), "<h1>new</h1>");
        return "done";
      },
    };
    const cliMember = (): ResolvedMember => ({
      ...member("cli", "builder", agent),
      connection: { id: "cli", kind: "opencode-cli", label: "OpenCode" },
    });
    const ws0 = await Workspace.open(dir, "cli-no");
    await ws0.write("index.html", "<h1>old</h1>");
    const no = await runWith("cli-no", "ask", () => false, cliMember());
    expect(no.asked.map((a) => a.kind)).toEqual(["review"]);
    expect(no.asked[0]!.detail).toContain("+<h1>new</h1>");
    expect(await no.ws.read("index.html")).toBe("<h1>old</h1>");
    expect(no.result.summary).toMatch(/declined/);

    const yes = await runWith("cli-yes", "ask", () => true, cliMember());
    expect(await yes.ws.read("index.html")).toBe("<h1>new</h1>");
  });

  it("allow-all for a kind stops asking for it in this run", async () => {
    const events: RunEvent[] = [];
    const a = new Approvals("ask", (e) => events.push(e));
    const first = a.ask("m", { kind: "edit", title: "one" });
    const second = a.ask("m", { kind: "edit", title: "two" });
    const tool = a.ask("m", { kind: "tool", title: "mcp" });
    const ids = events.filter((e) => e.type === "approval.request").map((e) => (e as { id: string }).id);
    a.resolve(ids[0]!, true, true);
    expect(await first).toBe(true);
    expect(await second).toBe(true); // already waiting, same kind
    expect(await a.ask("m", { kind: "edit", title: "three" })).toBe(true); // no longer asks
    a.declineAll();
    expect(await tool).toBe(false); // other kinds still needed an answer
  });
});

describe("any API", () => {
  it("accepts extra headers but refuses unsafe ones", () => {
    expect(parseHeaders({ "api-key": "k", "X-Org": "o" })).toEqual({ "api-key": "k", "X-Org": "o" });
    expect(() => parseHeaders({ Host: "evil" })).toThrow(/isn't allowed/);
    expect(() => parseHeaders({ "x-a": "line\nbreak" })).toThrow(/one-line/);
    expect(parseHeaders({})).toBeUndefined();
  });

  it("tells agents in Sleep mode to decide alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-away-"));
    const systems: string[] = [];
    const inner = fakeProvider({ review: [] });
    const p: Provider = {
      editsFiles: false,
      generate: (req, d, s) => (systems.push(req.system), inner.generate(req, d, s)),
    };
    try {
      await runCrew({
        prompt: "make a page",
        history: [],
        workspace: await Workspace.open(dir, "away"),
        roles: assignRoles([member("solo", "builder", p)]),
        settings: { maxReviewRounds: 1 },
        emit: () => {},
        signal: new AbortController().signal,
        autonomous: true,
      });
      expect(systems.length).toBeGreaterThan(2);
      for (const s of systems) expect(s).toContain("SLEEP MODE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("project emoji", () => {
  it("accepts one emoji of any kind and nothing else", () => {
    for (const e of ["🚀", "👨‍💻", "🇮🇱", "👍🏽", "❤️", "1️⃣"]) expect(validateEmoji(e)).toBe(e);
    for (const e of ["a", "🚀 hi", "<b>", "🚀🚀", "🚀".repeat(20)]) expect(() => validateEmoji(e)).toThrow(/single emoji/);
    expect(validateEmoji(null)).toBeNull();
  });

  it("is saved per project, shown in the list and can be removed", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "mc-emoji-"));
    const projectsDir = path.join(data, "projects");
    try {
      await Workspace.open(projectsDir, "site");
      await setProjectEmoji(projectsDir, "site", "🍕");
      expect((await listProjects(projectsDir)).find((p) => p.name === "site")?.emoji).toBe("🍕");
      await setProjectEmoji(projectsDir, "site", null);
      expect((await listProjects(projectsDir)).find((p) => p.name === "site")?.emoji).toBeUndefined();
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("opening an existing folder", () => {
  it("links a folder, works in place, and unlinks without touching it", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "mc-data-"));
    const projectsDir = path.join(data, "projects");
    const outside = await mkdtemp(path.join(tmpdir(), "My App-"));
    await writeFile(path.join(outside, "main.py"), "print(1)\n");
    try {
      const name = await linkProject(projectsDir, outside);
      expect(name).toMatch(/^My-App-/);
      expect(await linkProject(projectsDir, outside)).toBe(name); // same folder, same project
      const ws = await Workspace.open(projectsDir, name);
      expect(ws.root).toBe(outside);
      expect(await ws.read("main.py")).toBe("print(1)\n");
      expect((await listProjects(projectsDir)).find((p) => p.name === name)?.path).toBe(outside);
      await unlinkProject(projectsDir, name);
      expect((await listProjects(projectsDir)).some((p) => p.name === name)).toBe(false);
      expect(await readFile(path.join(outside, "main.py"), "utf8")).toBe("print(1)\n");
    } finally {
      await rm(data, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses the home folder, a drive root, MultiCode's data and non-folders", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "mc-data-"));
    const projectsDir = path.join(data, "projects");
    try {
      await expect(linkProject(projectsDir, homedir())).rejects.toThrow(/home folder/);
      await expect(linkProject(projectsDir, path.parse(data).root)).rejects.toThrow(/drive/);
      await expect(linkProject(projectsDir, data)).rejects.toThrow(/MultiCode itself/);
      await expect(linkProject(projectsDir, path.join(data, "nope"))).rejects.toThrow(/not a folder/);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("token savings", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-save-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const recording = (inner: Provider) => {
    const calls: { system: string; prompt: string }[] = [];
    const p: Provider = {
      editsFiles: inner.editsFiles,
      generate: (req, onDelta, signal) => {
        calls.push({ system: req.system, prompt: req.prompt });
        return inner.generate(req, onDelta, signal);
      },
    };
    return { p, calls };
  };

  it("fixes the last review's issues without paying for another review", async () => {
    const ws = await Workspace.open(dir, "one-round");
    const { p, calls } = recording(
      fakeProvider({
        review: ['{"approved":false,"summary":"bug","issues":[{"file":"app.js","problem":"p","fix":"f"}]}'],
      }),
    );
    await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([member("solo", "builder", p)]),
      settings: { maxReviewRounds: 1 },
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(calls.filter((c) => c.system.includes("REVIEWER"))).toHaveLength(1);
    expect(await ws.read("app.js")).toBe('console.log("fixed")\n');
  });

  it("sends builders their own files, not the whole project", async () => {
    const ws = await Workspace.open(dir, "context");
    await ws.write("big-unrelated.js", "x".repeat(50_000));
    const { p, calls } = recording(fakeProvider({ review: [] }));
    await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([member("solo", "builder", p)]),
      settings: { maxReviewRounds: 1 },
      emit: () => {},
      signal: new AbortController().signal,
    });
    const builds = calls.filter((c) => c.prompt.includes("YOUR TASK"));
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      expect(b.prompt).toContain("big-unrelated.js"); // listed in the tree
      expect(b.prompt).not.toContain('<file path="big-unrelated.js">'); // but not sent
    }
  });
});

describe("no build when there is nothing to build", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-talk-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const counting = (planText: string) => {
    const calls: string[] = [];
    const p: Provider = {
      editsFiles: false,
      async generate(req: GenerateRequest) {
        calls.push(req.system.includes("ARCHITECT") ? "architect" : "other");
        return planText;
      },
    };
    return { p, calls };
  };
  const run = async (prompt: string, p: Provider) =>
    runCrew({
      prompt,
      history: [],
      workspace: await Workspace.open(dir, "talk"),
      roles: assignRoles([member("solo", "builder", p)]),
      settings: { maxReviewRounds: 2 },
      emit: () => {},
      signal: new AbortController().signal,
    });

  it("answers a greeting or thanks without calling any model", async () => {
    for (const hi of ["hello", "Hi!", "שלום", "תודה רבה", "thanks."]) {
      const { p, calls } = counting("{}");
      const r = await run(hi, p);
      expect(calls).toEqual([]);
      expect(r.summary).toMatch(/\S/);
      expect(r.changedFiles).toEqual([]);
    }
    expect(smallTalkReply("hello, build me a todo app")).toBeUndefined();
  });

  it("lets the architect answer a question with one call and no builders", async () => {
    const { p, calls } = counting('{"reply":"The page is index.html.","tasks":[]}');
    const r = await run("which file is the main page?", p);
    expect(calls).toEqual(["architect"]);
    expect(r.summary).toBe("The page is index.html.");
    expect(r.changedFiles).toEqual([]);
  });

  it("still builds when the architect plans tasks", () => {
    const plan = parsePlan('{"summary":"s","tasks":[{"title":"Page","description":"d","files":["index.html"]}],"reply":"ignored"}', "x");
    expect(plan.reply).toBeUndefined();
    expect(plan.tasks).toHaveLength(1);
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

describe("manager model", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-mgr-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** A cheap manager that answers with fixed JSON (or garbage). */
  const managerProvider = (
    answers: { team?: unknown; dispatch?: unknown },
    seen: string[],
  ): Provider => ({
    editsFiles: false,
    async generate(req, onDelta) {
      seen.push(req.system.includes("choose who does") ? "team" : "dispatch");
      const out = req.system.includes("choose who does")
        ? JSON.stringify(answers.team)
        : JSON.stringify(answers.dispatch);
      onDelta(out);
      return out;
    },
  });

  it("assigns tasks so the architect only plans", async () => {
    const ws = await Workspace.open(dir, "dispatch");
    const systems: string[] = [];
    const base = fakeProvider({ review: [] });
    const spy: Provider = {
      editsFiles: false,
      generate: (req, d, s) => (
        systems.push(req.system),
        base.generate(req, d, s)
      ),
    };
    const seen: string[] = [];
    const manager = member(
      "manager",
      "architect",
      managerProvider(
        {
          dispatch: {
            assignments: [
              { task: "t1", assignee: "b1", why: "markup" },
              { task: "t2", assignee: "b2", why: "logic" },
            ],
          },
        },
        seen,
      ),
    );
    const events: RunEvent[] = [];
    await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([
        member("arch", "architect", spy),
        member("b1", "builder", spy),
        member("b2", "builder", spy),
        member("rev", "reviewer", spy),
      ]),
      settings: { maxReviewRounds: 0, dispatch: "smart" },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      manager,
    });
    expect(seen).toEqual(["dispatch"]);
    expect(systems.find((s) => s.includes("ARCHITECT"))).not.toContain(
      "DISPATCHER",
    );
    const ran = (id: string) =>
      events.find(
        (e) =>
          e.type === "task.status" && e.taskId === id && e.status === "running",
      );
    expect(ran("t1")).toMatchObject({ memberId: "b1" });
    expect(ran("t2")).toMatchObject({ memberId: "b2" });
    expect(events.find((e) => e.type === "plan")).toMatchObject({
      plan: { tasks: [{ why: "markup" }, { why: "logic" }] },
    });
  });

  it("staffs Auto, and a confused manager never breaks the run", async () => {
    const p = fakeProvider({ review: [] });
    const roles = assignRoles([
      member("a", "architect", p),
      member("b", "builder", p),
      member("c", "builder", p),
    ]);
    for (const [answers, architect] of [
      [
        {
          team: { architect: "c", reviewer: "a", builders: ["b", "a"] },
          dispatch: { assignments: [] },
        },
        "c",
      ],
      [
        {
          team: "nonsense",
          dispatch: { assignments: [{ task: "t9", assignee: "zzz" }] },
        },
        "a",
      ],
    ] as const) {
      const ws = await Workspace.open(dir, `auto-${architect}`);
      const seen: string[] = [];
      const events: RunEvent[] = [];
      const result = await runCrew({
        prompt: "make a page",
        history: [],
        workspace: ws,
        roles,
        settings: { maxReviewRounds: 0, dispatch: "smart" },
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        manager: member("manager", "architect", managerProvider(answers, seen)),
        managerPicksTeam: true,
      });
      expect(seen[0]).toBe("team");
      const planner = events.find(
        (e) => e.type === "agent.start" && e.title === "Planning the work",
      );
      expect(planner).toMatchObject({ memberId: architect });
      expect(result.changedFiles.length).toBeGreaterThan(0);
    }
  });
});

describe("specialist agents", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-agents-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("every reviewer checks in parallel; one rejection sends fixes back", async () => {
    const ws = await Workspace.open(dir, "reviewers");
    const base = fakeProvider({ review: [] });
    const securitySystems: string[] = [];
    let securityCalls = 0;
    const security: Provider = {
      editsFiles: false,
      async generate(req, onDelta) {
        securitySystems.push(req.system);
        const out =
          securityCalls++ === 0
            ? '{"approved":false,"summary":"unsafe","issues":[{"file":"app.js","problem":"eval of input","fix":"remove eval"}]}'
            : '{"approved":true,"summary":"safe now","issues":[]}';
        onDelta(out);
        return out;
      },
    };
    const sec = {
      ...member("sec", "reviewer", security),
      instructions: "Security reviewer: injection and XSS.",
    };
    const events: RunEvent[] = [];
    await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([
        member("arch", "architect", base),
        member("b1", "builder", base),
        member("b2", "builder", base),
        member("rev", "reviewer", base),
        sec,
      ]),
      settings: { maxReviewRounds: 2, dispatch: "smart" },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    const reviews = events.filter((e) => e.type === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      review: { approved: false, issues: [{ file: "app.js" }] },
    });
    expect(reviews[1]).toMatchObject({ review: { approved: true } });
    expect(securitySystems[0]).toContain("Your specialty");
    // Both reviewers ran in round 1.
    const starts = events.filter(
      (e) =>
        e.type === "agent.start" && e.title.startsWith("Reviewing the build"),
    );
    expect(
      new Set(starts.map((e) => (e as { memberId: string }).memberId)),
    ).toEqual(new Set(["rev", "sec"]));
    expect(events.some((e) => e.type === "tasks.added")).toBe(true);
  });

  it("presets are well-formed and the crew keeps only known ones", async () => {
    expect(new Set(AGENT_PRESETS.map((p) => p.id)).size).toBe(
      AGENT_PRESETS.length,
    );
    expect(
      AGENT_PRESETS.every(
        (p) =>
          p.instructions.length < 1000 &&
          ["architect", "builder", "reviewer"].includes(p.role),
      ),
    ).toBe(true);
    const store = new ConfigStore(path.join(dir, "cfg"));
    await store.load();
    const c = await store.upsertConnection({
      kind: "openai",
      apiKey: "sk-test-1234",
    });
    const crew = await store.setCrew([
      {
        name: "GPT-5",
        role: "reviewer",
        connectionId: c.id,
        preset: "security",
      },
      { name: "GPT-5", role: "builder", connectionId: c.id, preset: "made-up" },
    ]);
    expect(crew.map((m) => m.preset)).toEqual(["security", undefined]);
  });
});

describe("FreeLLMAPI and agent-desktop", () => {
  const free: Connection = {
    id: "f",
    kind: "openai-compatible",
    label: "FreeLLMAPI",
    baseUrl: "http://localhost:3001/v1",
    apiKey: "freellmapi-x",
  };

  it("names FreeLLMAPI's router models and counts the endpoint as free", () => {
    expect(connectionName("openai-compatible", free.baseUrl, "auto")).toBe(
      "FreeLLMAPI Auto (free)",
    );
    expect(
      connectionName("openai-compatible", free.baseUrl, "auto:smart"),
    ).toBe("FreeLLMAPI Smart (free)");
    expect(connectionName("openai-compatible", free.baseUrl, "fusion")).toBe(
      "FreeLLMAPI Fusion (free)",
    );
    expect(connectionName("openai-compatible", free.baseUrl)).toBe(
      "FreeLLMAPI",
    );
    expect(
      costTier({
        ...member("f", "builder", fakeProvider({ review: [] })),
        connection: free,
      }),
    ).toBe("free");
  });

  it("builds a free crew from FreeLLMAPI's router models", async () => {
    const models = (ids: string[]) =>
      (async () =>
        new Response(
          JSON.stringify({ data: ids.map((id) => ({ id })) }),
        )) as unknown as typeof fetch;
    const crew = await autoCrew(
      free,
      models(["auto", "fusion", "gemini-2.5-flash"]),
    );
    expect(crew.map((m) => [m.role, m.model, m.agents])).toEqual([
      ["architect", "auto:smart", 1],
      ["builder", "auto", 3],
      ["reviewer", "fusion", 1],
    ]);
    // A user-made "coding" profile is used for builders when it exists.
    expect(
      (await autoCrew(free, models(["auto", "auto:coding", "fusion"])))[1]!
        .model,
    ).toBe("auto:coding");
  });

  it("offers agent-desktop as an opt-in, high-risk, pinned plugin", () => {
    const p = PLUGINS.find((x) => x.id === "agent-desktop")!;
    expect(p).toMatchObject({
      category: "computer",
      risk: "high",
      defaultOn: false,
    });
    expect(p.server().args).toEqual(["-y", "agent-desktop@1.2.0", "mcp"]);
    expect(
      enabledPlugins({ enabled: [], disabled: [] }).some(
        (x) => x.id === "agent-desktop",
      ),
    ).toBe(false);
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
    await config.setSettings({ approvals: "all" });
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

  it("IDE saves and deletes files inside the project only", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: h,
      body: '{"name":"ide"}',
    });
    const put = (p: string, content: unknown = "x") =>
      fetch(`${base}/api/projects/ide/file`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ path: p, content }),
      });
    expect((await put("src/a.js", "let a = 1;\n")).status).toBe(200);
    expect(
      await readFile(path.join(dir, "projects", "ide", "src", "a.js"), "utf8"),
    ).toBe("let a = 1;\n");
    for (const bad of [
      "../escape.txt",
      "/etc/passwd",
      ".git/config",
      "node_modules/x.js",
    ])
      expect((await put(bad)).status).toBe(400);
    expect((await put("b.txt", 42)).status).toBe(400);
    const noCsrf = await fetch(`${base}/api/projects/ide/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"path":"c.txt","content":""}',
    });
    expect(noCsrf.status).toBe(403);
    const del = await fetch(`${base}/api/projects/ide/file?path=src%2Fa.js`, {
      method: "DELETE",
      headers: h,
    });
    expect(del.status).toBe(204);
    const files = await (await fetch(`${base}/api/projects/ide/files`)).json();
    expect(files).not.toContain("src/a.js");
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

  it("runs a Sleep mode thread alone: no approvals, even when they're on", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    const settings = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: h,
      body: '{"approvals":"ask"}',
    });
    expect(settings.ok).toBe(true);
    await fetch(`${base}/api/projects`, { method: "POST", headers: h, body: '{"name":"night"}' });
    const run = await (
      await fetch(`${base}/api/projects/night/runs`, {
        method: "POST",
        headers: h,
        body: '{"prompt":"build","sleep":true}',
      })
    ).json();
    expect(run).toMatchObject({ sleep: true });
    const res = await fetch(`${base}/api/runs/${run.id}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("run.done") && !text.includes("run.error"))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("run.done");
    expect(text).not.toContain("approval.request");
    expect(text).toContain('"sleep":true');
    await fetch(`${base}/api/settings`, { method: "PUT", headers: h, body: '{"approvals":"all"}' });
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
      await config.setSettings({ approvals: "all" });
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
      await config.setSettings({ approvals: "all" });
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
      await config.setSettings({ approvals: "all" });
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
    await config.setSettings({ approvals: "all" });
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

describe("threads (follow-ups remember the conversation)", () => {
  it("passes earlier turns and their answers to the architect, and groups them in one thread", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-thread-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const architectPrompts: string[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = {
        ...base,
        async generate(req, onDelta) {
          if (req.system.includes("ARCHITECT")) architectPrompts.push(req.prompt);
          return base.generate(req, onDelta);
        },
      };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      const finished = async (prompt: string, parentId?: string) => {
        const r = await runs.start("site", prompt, "build", { kind: "crew" }, false, parentId);
        await new Promise<void>((resolve) => {
          const off = runs.subscribe(r.id, (e) => {
            if (e.type === "run.done" || e.type === "run.error") {
              off();
              resolve();
            }
          });
        });
        return runs.get(r.id)!;
      };
      const first = await finished("Make a todo page");
      expect(first.reply).toBeTruthy();
      expect(first.changedFiles?.length).toBeGreaterThan(0);
      const second = await finished("Make it blue", first.id);
      expect(second.threadId).toBe(first.id);
      expect(second.parentId).toBe(first.id);
      const third = await finished("And add a footer", second.id);
      expect(third.threadId).toBe(first.id);
      const last = architectPrompts.at(-1)!;
      expect(last).toContain("Conversation so far");
      expect(last).toContain("Request: Make a todo page");
      expect(last).toContain("Request: Make it blue");
      expect(last).toContain(`Answer: ${first.reply!.slice(0, 40)}`);
      // A follow-up must name a run of the same project.
      await expect(runs.start("other", "x", "build", { kind: "crew" }, false, first.id)).rejects.toThrow(/thread/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("@ mentions", () => {
  it("reads mentioned project files for the architect, never protected or outside ones", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-mention-"));
    try {
      const ws = await Workspace.open(dir, "p");
      await ws.write("src/app.ts", "export const a = 1;\n");
      await ws.write(".env", "SECRET=1\n");
      await mkdir(path.join(ws.root, ".attachments"), { recursive: true });
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
      await writeFile(path.join(ws.root, ".attachments", "abcd1234.png"), png);
      const { text, images } = await readMentions(
        ws,
        "Fix @src/app.ts, see @.env and @../../etc/passwd and @missing.js. @.attachments/abcd1234.png",
        makeProtector([]),
      );
      expect(images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
      expect(text).not.toContain("abcd1234");
      expect(await ws.list()).not.toContain(".attachments/abcd1234.png");
      expect(text).toContain('<file path="src/app.ts">');
      expect(text).toContain("export const a = 1;");
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("passwd");
      expect(text).not.toContain("missing.js");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git (commit from the app)", () => {
  it("shows changes, commits them without attachments, and refuses an empty message", async () => {
    const { gitCommit, gitInit, gitStatus } = await import("../server/git.js");
    const dir = await mkdtemp(path.join(tmpdir(), "mc-git-"));
    try {
      expect((await gitStatus(dir)).repo).toBe(false);
      await gitInit(dir);
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
      await writeFile(path.join(dir, "index.html"), "<h1>hi</h1>");
      await mkdir(path.join(dir, ".attachments"));
      await writeFile(path.join(dir, ".attachments", "abcd1234.png"), "x");
      await writeFile(path.join(dir, ".mcp.json"), "{}");
      await mkdir(path.join(dir, ".claude", "skills"), { recursive: true });
      await writeFile(path.join(dir, ".claude", "skills", "x.md"), "x");
      const before = await gitStatus(dir);
      expect(before.files.map((f) => f.path)).toEqual(["index.html"]);
      await expect(gitCommit(dir, "  ")).rejects.toThrow(/message/);
      const after = await gitCommit(dir, "Add the page");
      expect(after.files).toEqual([]);
      expect(execFileSync("git", ["log", "--format=%s"], { cwd: dir }).toString().trim()).toBe("Add the page");
      expect(execFileSync("git", ["ls-files"], { cwd: dir }).toString().trim()).toBe("index.html");
      await expect(gitCommit(dir, "again")).rejects.toThrow(/Nothing to commit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("import MCP servers from other tools", () => {
  it("finds servers in Claude Code, Codex, Cursor and Gemini, hides values, and imports picks once", async () => {
    const { discoverMcp, importPlan, viewOf } = await import("../server/mcpImport.js");
    const home = await mkdtemp(path.join(tmpdir(), "mc-home-"));
    try {
      await writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { context: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
          projects: { "/x": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } } },
        }),
      );
      await mkdir(path.join(home, ".codex"));
      await writeFile(
        path.join(home, ".codex", "config.toml"),
        'model = "gpt-5"\n[mcp_servers.supa]\ncommand = "npx"\nargs = ["-y", "@supabase/mcp-server-supabase"]\nenv = { SUPABASE_ACCESS_TOKEN = "sbp_secret" }\n',
      );
      await mkdir(path.join(home, ".cursor"));
      await writeFile(
        path.join(home, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { context: { command: "npx", args: ["-y", "@upstash/context7-mcp"] }, "bad name!": { command: "x" } } }),
      );
      await mkdir(path.join(home, ".gemini"));
      await writeFile(path.join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { off: { command: "x", disabled: true } } }));

      const found = await discoverMcp(home, "linux");
      expect(found.map((f) => `${f.source}:${f.name}`).sort()).toEqual(
        ["Claude Code:context", "Claude Code:linear", "Codex:supa", "Cursor:bad-name-"].sort(),
      );
      const view = viewOf(found, [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }]);
      expect(JSON.stringify(view)).not.toContain("sbp_secret");
      expect(view.find((v) => v.name === "supa")?.envNames).toEqual(["SUPABASE_ACCESS_TOKEN"]);
      expect(view.find((v) => v.name === "linear")?.added).toBe(true);

      const plan = importPlan(
        found,
        [
          { source: "Codex", name: "supa" },
          { source: "Claude Code", name: "linear" },
          { source: "Codex", name: "supa" },
        ],
        [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
      );
      expect(plan.mcpServers.map((s) => s.name)).toEqual(["linear", "supa"]);
      expect(plan.env).toEqual({ SUPABASE_ACCESS_TOKEN: "sbp_secret" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("/review", () => {
  it("reviews uncommitted changes without secrets and changes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-review-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const prompts: string[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = {
        ...base,
        async generate(req, onDelta) {
          prompts.push(req.prompt);
          return base.generate(req, onDelta);
        },
      };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      const ws = await Workspace.open(path.join(dir, "projects"), "site");
      const { execFileSync } = await import("node:child_process");
      const sh = (...a: string[]) => execFileSync("git", a, { cwd: ws.root });
      await expect(runs.start("site", "Review", "build", { kind: "crew" }, false, undefined, { review: true })).rejects.toThrow(/Git/);
      sh("init");
      sh("config", "user.email", "t@example.com");
      sh("config", "user.name", "T");
      await ws.write("app.js", "let a = 1;\n");
      await ws.write(".env", "KEY=old\n");
      sh("add", "-A");
      sh("commit", "-m", "init");
      await expect(runs.start("site", "Review", "build", { kind: "crew" }, false, undefined, { review: true })).rejects.toThrow(/Nothing to review/);
      await ws.write("app.js", "let a = 2;\n");
      await ws.write(".env", "KEY=topsecret\n");
      await ws.write("new.js", "export const b = 3;\n");
      const r = await runs.start("site", "Review my changes", "build", { kind: "crew" }, false, undefined, { review: true });
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      const arch = prompts[0]!;
      expect(arch).toContain("Review the changes in the diff");
      expect(arch).toContain("+let a = 2;");
      expect(arch).toContain("new.js");
      expect(arch).not.toContain("topsecret");
      expect(prompts).toHaveLength(1);
      expect(await ws.read("app.js")).toBe("let a = 2;\n");
      expect(runs.get(r.id)?.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("custom / commands", () => {
  it("reads Claude Code and Codex command files, project first, with descriptions", async () => {
    const { listCommands } = await import("../server/commands.js");
    const home = await mkdtemp(path.join(tmpdir(), "mc-cmd-"));
    const proj = await mkdtemp(path.join(tmpdir(), "mc-cmdp-"));
    try {
      await mkdir(path.join(proj, ".claude", "commands", "git"), { recursive: true });
      await writeFile(path.join(proj, ".claude", "commands", "fix.md"), "---\ndescription: Fix an issue\n---\nFix issue $ARGUMENTS and add a test.");
      await writeFile(path.join(proj, ".claude", "commands", "git", "pr.md"), "# Open a PR\nWrite a PR description.");
      await mkdir(path.join(home, ".claude", "commands"), { recursive: true });
      await writeFile(path.join(home, ".claude", "commands", "fix.md"), "global version");
      await mkdir(path.join(home, ".codex", "prompts"), { recursive: true });
      await writeFile(path.join(home, ".codex", "prompts", "explain.md"), "Explain $ARGUMENTS simply.");
      const cmds = await listCommands(proj, home);
      expect(cmds.map((c) => `${c.source}:${c.name}`)).toEqual(["project:fix", "project:git:pr", "Codex:explain"]);
      expect(cmds[0]).toMatchObject({ description: "Fix an issue", body: "Fix issue $ARGUMENTS and add a test." });
      expect(cmds[1]!.description).toBe("Open a PR");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
    }
  });
});

describe("reasoning effort", () => {
  it("is stored for Claude Code, Codex and Anthropic only, and cleared with null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-effort-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      const a = await config.upsertConnection({ kind: "anthropic", apiKey: "sk-ant-x", effort: "high" });
      expect(config.connection(a.id)?.effort).toBe("high");
      expect(config.views().find((c) => c.id === a.id)?.effort).toBe("high");
      await config.upsertConnection({ effort: null }, a.id);
      expect(config.connection(a.id)?.effort).toBeUndefined();
      await expect(config.upsertConnection({ effort: "extreme" }, a.id)).rejects.toThrow(/effort/);
      await expect(
        config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", effort: "low" }),
      ).rejects.toThrow(/effort/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("check command (like a hook on edits)", () => {
  it("runs after the build, turns a failure into a fix, and reports the final result", async () => {
    const { setProjectCheck } = await import("../server/workspace.js");
    const dir = await mkdtemp(path.join(tmpdir(), "mc-check-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 1, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const reviewerPrompts: string[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = {
        ...base,
        async generate(req, onDelta) {
          if (req.system.includes("REVIEWER")) reviewerPrompts.push(req.prompt);
          return base.generate(req, onDelta);
        },
      };
      const projects = path.join(dir, "projects");
      const runs = new RunManager(config, projects, () => provider, path.join(dir, "runs"));
      await Workspace.open(projects, "site");
      await setProjectCheck(projects, "site", `node -e "process.exit(require('fs').readFileSync('app.js','utf8').includes('fixed')?0:1)"`);
      const events: RunEvent[] = [];
      const r = await runs.start("site", "Build it");
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          events.push(e);
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      const checks = events.filter((e): e is Extract<RunEvent, { type: "check" }> => e.type === "check");
      expect(checks.map((c) => c.ok)).toEqual([false, true]);
      expect(reviewerPrompts[0]).toContain("FAILED");
      expect(events.some((e) => e.type === "tasks.added")).toBe(true);
      const done = events.find((e) => e.type === "run.done") as Extract<RunEvent, { type: "run.done" }>;
      expect(done.summary).toContain("passes");
      await expect(setProjectCheck(projects, "site", "a\nb")).rejects.toThrow(/one line/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hooks (as in Claude Code)", () => {
  it("blocks or adds context before a request, and runs on file changes and at the end", async () => {
    const { matches } = await import("../server/hooks.js");
    expect(matches("**/*.js", "app.js")).toBe(true);
    expect(matches("**/*.js", "src/a/b.js")).toBe(true);
    expect(matches("*.html", "src/index.html")).toBe(false);
    const dir = await mkdtemp(path.join(tmpdir(), "mc-hooks-"));
    try {
      const log = path.join(dir, "hook.log");
      const script = path.join(dir, "hook.cjs");
      await writeFile(
        script,
        `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d);require("fs").appendFileSync(${JSON.stringify(log)}, e.hook_event_name+":"+(e.file_path||e.status||e.prompt||"")+"\\n");
if(e.hook_event_name==="UserPromptSubmit"){ if(/forbidden/.test(e.prompt)){console.error("no forbidden work");process.exit(2)} console.log("Team rule: use tabs."); }});`,
      );
      const failing = path.join(dir, "fail.cjs");
      await writeFile(failing, `console.error("lint failed");process.exit(1)`);
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({
        approvals: "all",
        maxReviewRounds: 0,
        freeFallback: { enabled: false },
        hooks: [
          { event: "UserPromptSubmit", command: `node "${script}"` },
          { event: "PostToolUse", command: `node "${script}"`, matcher: "**/*.js" },
          { event: "PostToolUse", command: `node "${failing}"`, matcher: "**/*.html" },
          { event: "Stop", command: `node "${script}"` },
        ],
      });
      await expect(config.setSettings({ hooks: [{ event: "Sometime", command: "x" }] })).rejects.toThrow(/event/);
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const archPrompts: string[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = {
        ...base,
        async generate(req, onDelta) {
          if (req.system.includes("ARCHITECT")) archPrompts.push(req.prompt);
          return base.generate(req, onDelta);
        },
      };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      await expect(runs.start("site", "do the forbidden thing")).rejects.toThrow(/no forbidden work/);
      const events: RunEvent[] = [];
      const r = await runs.start("site", "Build it");
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          events.push(e);
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      await new Promise((res) => setTimeout(res, 1500));
      expect(archPrompts[0]).toContain("Team rule: use tabs.");
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toContain("UserPromptSubmit:do the forbidden thing");
      expect(lines).toContain("PostToolUse:app.js");
      expect(lines).not.toContain("PostToolUse:index.html");
      expect(lines.at(-1)).toBe("Stop:done");
      const failed = (await runs.events(r.id)).filter((e) => e.type === "hook");
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(failed[0])).toContain("lint failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parallel tasks (sandboxes, like Codex)", () => {
  it("runs sandboxed tasks side by side, keeps direct runs out meanwhile, and applies both", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-par-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false }, safety: "sandbox" });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      let active = 0;
      let peak = 0;
      const provider: Provider = {
        editsFiles: false,
        async generate(req, onDelta) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 300));
          active--;
          const which = req.prompt.includes("Page A") ? "a" : "b";
          const out = req.system.includes("ARCHITECT")
            ? JSON.stringify({ summary: "One file.", tasks: [{ title: `Page ${which.toUpperCase()}`, description: "x", files: [`${which}.html`] }] })
            : `<file path="${which}.html">\n<h1>${which}</h1>\n</file>`;
          onDelta(out);
          return out;
        },
      };
      const sync = { harness: new HarnessSync(path.join(dir, "sync"), new ProjectMemory(path.join(dir, "memory"))), memory: new ProjectMemory(path.join(dir, "memory")), dataDir: dir, previewOrigin: "http://localhost:1" };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"), sync);
      const wait = (id: string) =>
        new Promise<void>((resolve) => {
          const off = runs.subscribe(id, (e) => {
            if (e.type === "run.done" || e.type === "run.error") {
              off();
              resolve();
            }
          });
        });
      const a = await runs.start("site", "Page A please");
      const b = await runs.start("site", "Page B please");
      await config.setSettings({ safety: "direct" });
      await expect(runs.start("site", "direct edit")).rejects.toThrow(/crew at work/);
      await Promise.all([wait(a.id), wait(b.id)]);
      expect(peak).toBeGreaterThanOrEqual(2);
      expect(runs.get(a.id)?.pending).toBe("sandbox");
      expect(runs.get(b.id)?.pending).toBe("sandbox");
      await runs.apply(a.id);
      await runs.apply(b.id);
      const ws = await Workspace.open(path.join(dir, "projects"), "site");
      expect((await ws.list()).filter((f) => f.endsWith(".html")).sort()).toEqual(["a.html", "b.html"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Anthropic prompt caching (against a recorded fake API)", () => {
  it("marks the system prompt cacheable, sends effort, and reports cached tokens", async () => {
    const http = await import("node:http");
    const { AnthropicProvider } = await import("../server/providers/api.js");
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        const warm = bodies.length > 1;
        const usage = { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: warm ? 0 : 2000, cache_read_input_tokens: warm ? 2000 : 0 };
        const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage } }));
        res.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
        res.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
        res.end(ev("message_stop", { type: "message_stop" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const p = new AnthropicProvider({ id: "a", kind: "anthropic", label: "A", apiKey: "sk-ant-x", baseUrl: `http://127.0.0.1:${port}`, defaultModel: "claude-opus-5-5", effort: "high" });
      const usages: { input: number; cached?: number }[] = [];
      for (let i = 0; i < 2; i++)
        await p.generate({ system: "You are the ARCHITECT. ".repeat(50), prompt: `request ${i}`, cwd: ".", mode: "text", onUsage: (u) => usages.push(u) }, () => {}, AbortSignal.timeout(10_000));
      const sys = bodies[0]!.system as { type: string; text: string; cache_control?: unknown }[];
      expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect(bodies[0]!.output_config).toEqual({ effort: "high" });
      expect(JSON.stringify(bodies[0]!.system)).toBe(JSON.stringify(bodies[1]!.system));
      expect(usages[0]).toMatchObject({ input: 2012, cached: 0 });
      expect(usages[1]).toMatchObject({ input: 12, cached: 2000 });
    } finally {
      server.close();
    }
  });
});

describe("a request for what is already there", () => {
  it("finishes as done (nothing to change) instead of failing and retrying", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-same-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      let builds = 0;
      const provider: Provider = {
        editsFiles: false,
        async generate(req, onDelta) {
          const out = req.system.includes("ARCHITECT")
            ? JSON.stringify({ summary: "One page.", tasks: [{ title: "Page", description: "x", files: ["index.html"] }] })
            : (builds++, '<file path="index.html">\n<h1>same</h1>\n</file>');
          onDelta(out);
          return out;
        },
      };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      const ws = await Workspace.open(path.join(dir, "projects"), "site");
      await ws.write("index.html", "<h1>same</h1>\n");
      const events: RunEvent[] = [];
      const r = await runs.start("site", "Make the page");
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          events.push(e);
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      expect(events.some((e) => e.type === "run.error")).toBe(false);
      expect(builds).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("models at the same time", () => {
  const mk = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-cmp-"));
    const config = new ConfigStore(dir);
    await config.load();
    await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
    const a = await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://a", defaultModel: "alpha", label: "Alpha" });
    const b = await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://b", defaultModel: "beta", label: "Beta" });
    let active = 0;
    let peak = 0;
    const judged: string[] = [];
    const factory = (conn: Connection): Provider => ({
      editsFiles: false,
      async generate(req, onDelta) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 250));
        active--;
        let out: string;
        if (req.system.includes("comparing several versions")) {
          judged.push(req.prompt);
          out = JSON.stringify({ best: "v2", why: "Beta handles the empty case." });
        } else if (req.system.includes("ARCHITECT"))
          out = JSON.stringify({ summary: "One file.", tasks: [{ title: "Sum", description: "x", files: ["sum.js"] }] });
        else out = `<file path="sum.js">\nexport const sum = (a, b) => a + b; // ${conn.label}\n</file>`;
        onDelta(out);
        return out;
      },
    });
    const sync = { harness: new HarnessSync(path.join(dir, "sync"), new ProjectMemory(path.join(dir, "memory"))), memory: new ProjectMemory(path.join(dir, "memory")), dataDir: dir, previewOrigin: "http://localhost:1" };
    const runs = new RunManager(config, path.join(dir, "projects"), factory, path.join(dir, "runs"), sync);
    const wait = (id: string) =>
      new Promise<RunEvent[]>((resolve) => {
        const seen: RunEvent[] = [];
        const off = runs.subscribe(id, (e) => {
          seen.push(e);
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve(seen);
          }
        });
      });
    return { dir, config, runs, wait, peak: () => peak, judged, ids: [a.id, b.id] };
  };

  it("Compare: every model does the same task at once, the reviewer recommends one, you apply it", async () => {
    const t = await mk();
    try {
      const r = await t.runs.start("site", "Write a sum function", "compare");
      const events = await t.wait(r.id);
      expect(t.peak()).toBeGreaterThanOrEqual(2);
      const variants = events.find((e) => e.type === "variants") as Extract<RunEvent, { type: "variants" }>;
      expect(new Set(variants.variants.map((v) => v.title)).size).toBe(2);
      const verdict = events.find((e) => e.type === "verdict") as Extract<RunEvent, { type: "verdict" }>;
      expect(verdict.best).toBe("v2");
      expect(verdict.files.v1).toEqual(["sum.js"]);
      expect(t.judged[0]).toContain("Version v1");
      expect(t.runs.get(r.id)?.pending).toBe("design");
      await t.runs.apply(r.id, "v2");
      const ws = await Workspace.open(path.join(t.dir, "projects"), "site");
      expect(await ws.read("sum.js")).toContain("// ");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("Compare needs two different models", async () => {
    const t = await mk();
    try {
      await t.config.deleteConnection(t.ids[1]!);
      const r = await t.runs.start("site", "Write a sum function", "compare");
      const events = await t.wait(r.id);
      expect(JSON.stringify(events.find((e) => e.type === "run.error"))).toContain("at least two different models");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });

  it("a task started in parallel runs beside a direct run, in its own copy", async () => {
    const t = await mk();
    try {
      const a = await t.runs.start("site", "First task");
      const b = await t.runs.start("site", "Second task", "build", { kind: "crew" }, false, undefined, { parallel: true });
      await expect(t.runs.start("site", "Third, direct")).rejects.toThrow(/crew at work/);
      await Promise.all([t.wait(a.id), t.wait(b.id)]);
      expect(t.peak()).toBeGreaterThanOrEqual(2);
      expect(t.runs.get(a.id)?.pending).toBeUndefined();
      expect(t.runs.get(b.id)?.pending).toBe("sandbox");
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });
});

describe("work on a GitHub repository", () => {
  it("accepts owner/repo and https addresses, never options or local paths", async () => {
    const { cloneUrl, repoName } = await import("../server/git.js");
    expect(cloneUrl("eitandan212/Multicode")).toBe("https://github.com/eitandan212/Multicode.git");
    expect(cloneUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(cloneUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    for (const bad of ["--upload-pack=x", "/etc", "file:///etc", "ext::sh -c x", "http://x/y", ""])
      expect(() => cloneUrl(bad)).toThrow(/repository address/);
    expect(repoName("https://github.com/eitandan212/Multicode.git")).toBe("multicode");
  });

  it("clones, branches, pulls new commits and knows it's on GitHub", async () => {
    const { gitBranches, gitCheckout, gitClone, gitPull, gitStatus } = await import("../server/git.js");
    const { execFileSync } = await import("node:child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "mc-clone-"));
    const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" } }).toString();
    try {
      const origin = path.join(dir, "origin");
      await mkdir(origin);
      sh(origin, "init", "-b", "main");
      await writeFile(path.join(origin, "README.md"), "hi\n");
      sh(origin, "add", "-A");
      sh(origin, "commit", "-m", "first");
      const work = path.join(dir, "work");
      await gitClone(work, origin);
      expect(await readFile(path.join(work, "README.md"), "utf8")).toBe("hi\n");
      expect((await gitBranches(work)).current).toBe("main");
      const s = await gitCheckout(work, "feature/login", true);
      expect(s.branch).toBe("feature/login");
      await expect(gitCheckout(work, "--bad", true)).rejects.toThrow(/Branch names/);
      await gitCheckout(work, "main", false);
      await writeFile(path.join(origin, "README.md"), "hi again\n");
      sh(origin, "commit", "-am", "second");
      await gitPull(work);
      expect(await readFile(path.join(work, "README.md"), "utf8")).toBe("hi again\n");
      sh(work, "remote", "set-url", "origin", "https://github.com/acme/site.git");
      expect((await gitStatus(work)).github).toBe("acme/site");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-compact", () => {
  it("shrinks big file contents first and keeps the instructions and the task", async () => {
    const { compactPrompt, isContextOverflow } = await import("../server/crew/compact.js");
    const big = "x".repeat(50_000);
    const prompt = `RULES: be careful\n<file path="a.js">\n${big}\n</file>\n<file path="b.js">\nsmall\n</file>\nYOUR TASK: fix it`;
    const out = compactPrompt(prompt, 10_000);
    expect(out.length).toBeLessThanOrEqual(10_500);
    expect(out).toContain("RULES: be careful");
    expect(out).toContain("YOUR TASK: fix it");
    expect(out).toContain("small");
    expect(out).toContain("trimmed so the request fits");
    expect(isContextOverflow("400 prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
    expect(isContextOverflow("This model's maximum context length is 128000 tokens")).toBe(true);
    expect(isContextOverflow("401 invalid x-api-key")).toBe(false);
  });

  it("retries a request that was too long, compacted, and the run succeeds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-compact-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const LIMIT = 30_000;
      const sizes: number[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = {
        ...base,
        async generate(req, onDelta) {
          sizes.push(req.prompt.length);
          if (req.prompt.length > LIMIT) throw new Error("400 prompt is too long: 90000 tokens > 30000 maximum");
          return base.generate(req, onDelta);
        },
      };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      const ws = await Workspace.open(path.join(dir, "projects"), "site");
      await ws.write("index.html", `<p>${"lorem ipsum ".repeat(4000)}</p>\n`);
      await ws.write("app.js", `// ${"x".repeat(30_000)}\n`);
      const events: RunEvent[] = [];
      const r = await runs.start("site", "Improve it");
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          events.push(e);
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      expect(events.some((e) => e.type === "compacted")).toBe(true);
      expect(events.some((e) => e.type === "run.error")).toBe(false);
      expect(Math.max(...sizes)).toBeGreaterThan(LIMIT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a long thread's beginning, compacted, and its last turns in full", async () => {
    const { compactThread } = await import("../server/runs.js");
    const turns = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`, project: "p", prompt: `request ${i}`, status: "done" as const, startedAt: i, reply: `answer ${i}`,
    }));
    const out = compactThread(turns, (r) => `Request: ${r.prompt}\nAnswer: ${r.reply}`);
    expect(out).toHaveLength(4);
    expect(out[0]).toContain("Earlier in this thread (compacted)");
    expect(out[0]).toContain("request 0 → answer 0");
    expect(out[3]).toBe("Request: request 9\nAnswer: answer 9");
  });
});

describe("context ring", () => {
  it("knows each model's context window", () => {
    expect(contextWindow("anthropic", "claude-opus-5-5")).toBe(1_000_000);
    expect(contextWindow("anthropic", "claude-haiku-4-5")).toBe(200_000);
    expect(contextWindow("codex-cli", "")).toBe(400_000);
    expect(contextWindow("openai", "gpt-4o")).toBe(128_000);
    expect(contextWindow("gemini", "gemini-2.5-pro")).toBe(1_000_000);
    expect(contextWindow("openai-compatible", "some-local-model")).toBe(128_000);
  });
});

describe("chats", () => {
  it("renames, pins, archives and deletes a whole chat with its files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-chats-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const runsDir = path.join(dir, "runs");
      const runs = new RunManager(config, path.join(dir, "projects"), () => fakeProvider({ review: [] }), runsDir);
      const done = (id: string) =>
        new Promise<void>((resolve) => {
          const off = runs.subscribe(id, (e) => {
            if (e.type === "run.done" || e.type === "run.error") {
              off();
              resolve();
            }
          });
        });
      const a = await runs.start("site", "First");
      await done(a.id);
      const b = await runs.start("site", "Follow-up", "build", { kind: "crew" }, false, a.id);
      await done(b.id);
      const s = await runs.updateChat(b.id, { title: "  My   chat ", pinned: true, archived: true });
      expect(s).toMatchObject({ id: a.id, title: "My chat", pinned: true, archived: true });
      await runs.updateChat(a.id, { title: null, pinned: false });
      expect(runs.list().find((r) => r.id === a.id)?.title).toBeUndefined();
      const reloaded = new RunManager(config, path.join(dir, "projects"), () => fakeProvider({ review: [] }), runsDir);
      await reloaded.load();
      expect(reloaded.list().find((r) => r.id === a.id)?.archived).toBe(true);
      await runs.deleteChat(b.id);
      expect(runs.list()).toEqual([]);
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(runsDir)).filter((f) => f.startsWith(a.id) || f.startsWith(b.id))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("custom skills", () => {
  it("saves, lists and deletes your skills, and turns GitHub links into the raw SKILL.md", async () => {
    const { CustomSkills, rawUrl, installRequest } = await import("../server/customSkills.js");
    const dir = await mkdtemp(path.join(tmpdir(), "mc-skills-"));
    try {
      const cs = new CustomSkills(dir);
      await cs.save({ name: "Our API Style", description: "How we write handlers", body: "Validate input." });
      expect((await cs.list()).map((s) => s.name)).toEqual(["our-api-style"]);
      expect((await cs.save({ name: "../x", body: "x" })).name).toBe("x");
      await cs.remove("x");
      await expect(cs.save({ name: "!!!", body: "x" })).rejects.toThrow(/name/);
      expect(rawUrl("https://github.com/acme/skills/tree/main/skills/pdf")).toBe("https://raw.githubusercontent.com/acme/skills/main/skills/pdf/SKILL.md");
      expect(rawUrl("https://github.com/acme/skills/blob/main/x/SKILL.md")).toBe("https://raw.githubusercontent.com/acme/skills/main/x/SKILL.md");
      expect(() => rawUrl("file:///etc/passwd")).toThrow(/https/);
      const fake = (async () => new Response("---\nname: pdf-tools\ndescription: Work with PDFs\n---\n\n# PDFs\nUse pypdf.")) as typeof fetch;
      const s = await cs.install("https://github.com/acme/skills/tree/main/skills/pdf", fake);
      expect(s).toMatchObject({ name: "pdf-tools", description: "Work with PDFs" });
      const html = (async () => new Response("<!doctype html><html></html>")) as typeof fetch;
      await expect(cs.install("https://example.com/page", html)).rejects.toThrow(/web page/);
      expect(installRequest("install the skill from https://github.com/a/b/tree/main/s")).toBe("https://github.com/a/b/tree/main/s");
      expect(installRequest("תתקין את הסקיל מ https://x.com/SKILL.md")).toBe("https://x.com/SKILL.md");
      expect(installRequest("build a skill tree page")).toBeUndefined();
      await cs.remove("our-api-style");
      expect((await cs.list()).map((x) => x.name)).toEqual(["pdf-tools"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives your skills to API agents", async () => {
    const { CustomSkills } = await import("../server/customSkills.js");
    const dir = await mkdtemp(path.join(tmpdir(), "mc-skills2-"));
    try {
      const config = new ConfigStore(dir);
      await config.load();
      await config.setSettings({ approvals: "all", maxReviewRounds: 0, freeFallback: { enabled: false } });
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const systems: string[] = [];
      const base = fakeProvider({ review: [] });
      const provider: Provider = { ...base, async generate(req, onDelta) { systems.push(req.system); return base.generate(req, onDelta); } };
      const runs = new RunManager(config, path.join(dir, "projects"), () => provider, path.join(dir, "runs"));
      runs.customSkills = new CustomSkills(path.join(dir, "custom"));
      await runs.customSkills.save({ name: "tabs-only", description: "Indent with tabs", body: "Always indent with tabs." });
      const r = await runs.start("site", "Build it");
      await new Promise<void>((resolve) => {
        const off = runs.subscribe(r.id, (e) => {
          if (e.type === "run.done" || e.type === "run.error") {
            off();
            resolve();
          }
        });
      });
      expect(systems.some((s) => s.includes("Always indent with tabs."))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
