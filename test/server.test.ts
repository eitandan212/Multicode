import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { ConfigStore, type Connection } from "../server/config.js";
import { captureBaseline, diffChanges } from "../server/crew/diff.js";
import { assignRoles, runCrew, scheduleTasks, type ResolvedMember } from "../server/crew/orchestrator.js";
import { extractJson, parseFileOps, parsePlan, parseReview } from "../server/crew/parse.js";
import { buildCliArgs, CLI_SPECS, parseClaudeStreamLine, parseOpenCodeLine, type CliKind } from "../server/providers/cli.js";
import type { GenerateRequest, Provider } from "../server/providers/types.js";
import { RunManager } from "../server/runs.js";
import type { PlanTask, RunEvent } from "../server/shared.js";
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
    expect(extractJson('Plan:\n```json\n{"summary":"use {x}","tasks":[]}\n```')).toEqual({ summary: "use {x}", tasks: [] });
    expect(extractJson('noise {"a": "}"} tail')).toEqual({ a: "}" });
    expect(extractJson("nothing here")).toBeUndefined();
  });

  it("falls back to a single task when the plan is unusable", () => {
    const plan = parsePlan("I think we should…", "make a todo app");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.description).toBe("make a todo app");
  });

  it("reads review verdicts", () => {
    expect(parseReview('{"approved":false,"summary":"bug","issues":[{"file":"a.js","problem":"x","fix":"y"}]}').approved).toBe(false);
    expect(parseReview('{"summary":"fine","issues":[]}').approved).toBe(true);
    expect(parseReview("no json").approved).toBe(true);
  });
});

describe("workspace safety", () => {
  it("rejects escaping and protected paths", () => {
    for (const bad of ["../x", "/etc/passwd", "C:/win", "a/../../b", ".git/config", "node_modules/x/y.js", ""])
      expect(() => safeRelative(bad)).toThrow();
    expect(safeRelative("./src\\app.js")).toBe("src/app.js");
  });
});

describe("cli adapters", () => {
  const req: GenerateRequest = { system: "", prompt: "", cwd: "/p", mode: "edit", model: "m" };
  it("never uses blanket permission bypass flags", () => {
    for (const kind of Object.keys(CLI_SPECS) as CliKind[]) {
      for (const mode of ["text", "edit"] as const) {
        const args = buildCliArgs(kind, { ...req, mode }, "do it");
        expect(args.join(" ")).not.toMatch(/dangerously|yolo|bypass/i);
        expect(args).not.toContain("--auto");
        expect(args).not.toContain("-y");
      }
    }
    expect(buildCliArgs("opencode-cli", { ...req, mode: "text" }, "x")).toEqual(expect.arrayContaining(["--agent", "plan", "--dir", "/p"]));
    expect(buildCliArgs("qwen-cli", { ...req, mode: "text" }, "x")).toEqual(expect.arrayContaining(["--approval-mode", "plan"]));
    const ocEnv = JSON.parse(CLI_SPECS["opencode-cli"].env!(req).OPENCODE_CONFIG_CONTENT!);
    expect(ocEnv.permission.bash).toBe("deny");
    expect(buildCliArgs("codex-cli", { ...req, mode: "text" }, "x")).toContain("read-only");
    expect(buildCliArgs("claude-cli", { ...req, mode: "text" }, "x")).toContain("plan");
  });
  it("parses Claude Code stream-json", () => {
    expect(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')).toEqual({ text: "hi" });
    expect(parseClaudeStreamLine('{"type":"result","is_error":false,"result":"done"}')).toEqual({ result: "done" });
    expect(parseClaudeStreamLine("garbage")).toEqual({});
  });
  it("parses OpenCode json events", () => {
    expect(parseOpenCodeLine('{"type":"text","part":{"type":"text","text":"done"}}')).toEqual({ text: "done" });
    expect(parseOpenCodeLine('{"type":"tool_use","part":{"tool":"write","state":{"status":"completed","input":{"filePath":"/p/app.js"}}}}')).toEqual({ text: "▸ write app.js" });
    expect(parseOpenCodeLine('{"type":"error","error":{"name":"APIError","data":{"message":"bad key"}}}')).toEqual({ error: "bad key" });
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
      maxParallel = Math.max(maxParallel, [...active].filter((k) => k.startsWith("task:")).length);
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
            { title: "Page", description: "html", files: ["index.html"] },
            { title: "Logic", description: "js", files: ["app.js"] },
          ],
        });
      else if (req.system.includes("REVIEWER")) out = script.review[reviews++] ?? '{"approved":true,"summary":"ok","issues":[]}';
      else if (req.prompt.includes("YOUR TASK: Page")) out = '<file path="index.html">\n<script src="app.js"></script>\n</file>';
      else if (req.prompt.includes("YOUR TASK: Logic")) out = '<file path="app.js">\nconsole.log(1)\n</file>';
      else out = '<file path="app.js">\nconsole.log("fixed")\n</file>';
      onDelta(out);
      return out;
    },
  };
}

const conn = (id: string): Connection => ({ id, kind: "openai-compatible", label: id, baseUrl: "http://x" });
const member = (id: string, role: ResolvedMember["role"], provider: Provider): ResolvedMember => ({
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
      review: ['{"approved":false,"summary":"bug","issues":[{"file":"app.js","problem":"logs 1","fix":"log fixed"}]}'],
    });
    const events: RunEvent[] = [];
    const result = await runCrew({
      prompt: "make a page",
      history: [],
      workspace: ws,
      roles: assignRoles([member("arch", "architect", p), member("b1", "builder", p), member("b2", "builder", p), member("rev", "reviewer", p)]),
      settings: { maxReviewRounds: 2 },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    expect(result.changedFiles).toEqual(["app.js", "index.html"]);
    expect(await ws.read("app.js")).toBe('console.log("fixed")\n');
    expect(events.filter((e) => e.type === "review")).toHaveLength(2);
    const builders = new Set(events.flatMap((e) => (e.type === "task.status" && e.status === "running" ? [e.memberId] : [])));
    expect(builders.size).toBe(2);
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
    const { app } = createApp({ config, projectsDir: path.join(dir, "projects"), providerFactory: () => fakeProvider({ review: [] }) });
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
    const r = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"x"}' });
    expect(r.status).toBe(403);
  });

  it("never returns API keys", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    const created = await fetch(`${base}/api/connections`, { method: "POST", headers: h, body: JSON.stringify({ kind: "anthropic", apiKey: "sk-secret-1234" }) });
    expect(created.status).toBe(201);
    const state = await (await fetch(`${base}/api/state`)).text();
    expect(state).not.toContain("sk-secret");
    expect(state).toContain("…1234");
  });

  it("runs a crew end to end over HTTP + SSE", async () => {
    const h = { "content-type": "application/json", "x-multicode": "1" };
    await fetch(`${base}/api/projects`, { method: "POST", headers: h, body: '{"name":"site"}' });
    const run = await (await fetch(`${base}/api/projects/site/runs`, { method: "POST", headers: h, body: '{"prompt":"build"}' })).json();
    const res = await fetch(`${base}/api/runs/${run.id}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("run.done") && !text.includes("run.error")) text += new TextDecoder().decode((await reader.read()).value);
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
      const diffs = await diffChanges(ws, base, ["keep.js", "gone.js", "new.js"]);
      expect(diffs.map((d) => [d.path, d.change, d.additions, d.deletions])).toEqual([
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
      await config.upsertConnection({ kind: "openai-compatible", baseUrl: "http://x", defaultModel: "m" });
      const runsDir = path.join(dir, "runs");
      const factory = () => fakeProvider({ review: [] });
      const first = new RunManager(config, path.join(dir, "projects"), factory, runsDir);
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
        JSON.stringify({ id: ghost, project: "p1", prompt: "old", status: "running", startedAt: 1 }),
      );

      const second = new RunManager(config, path.join(dir, "projects"), factory, runsDir);
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
