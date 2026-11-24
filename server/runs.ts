import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigStore, Connection } from "./config.js";
import { HttpError } from "./config.js";
import { rm } from "node:fs/promises";
import { assignRoles, DESIGN_DIRECTIONS, hashText, runCrew, runDesign, type Checkpoint, type ResolvedMember } from "./crew/orchestrator.js";
import { copyToSandbox, makeProtector } from "./guard.js";
import { CLI_BINARIES, findBinary } from "./providers/cli.js";
import type { ProviderFactory } from "./providers/registry.js";
import type { CrewMember, RunEvent, RunSummary } from "./shared.js";
import type { HarnessSync, ProjectMemory, SyncExtras } from "./sync.js";
import { memoryGraphFile, pluginContributions, enabledPlugins } from "./plugins.js";
import { inlineSkills, selectPacks, type ActivePack } from "./skills.js";
import { recordRun } from "./graph.js";
import { connectionName, HARNESS_NAMES, type McpServer, type RunMode } from "./shared.js";
import { Workspace } from "./workspace.js";

type Listener = (e: RunEvent) => void;

interface Run extends RunSummary {
  /** Loaded lazily for finished runs; always present while running. */
  events: RunEvent[] | null;
  listeners: Set<Listener>;
  controller?: AbortController;
  log?: WriteStream;
}

const MAX_EVENTS = 20_000;
const MAX_CACHED_EVENT_LOGS = 12;
const RUN_ID = /^[0-9a-f-]{36}$/;

const summaryOf = ({ id, project, prompt, status, startedAt, endedAt, undoneAt, canUndo, pending, mode, resolution }: Run): RunSummary => ({
  id,
  project,
  prompt,
  status,
  startedAt,
  endedAt,
  undoneAt,
  canUndo,
  pending,
  mode,
  resolution,
});

export interface UndoResult {
  restored: string[];
  conflicts: string[];
  skipped: string[];
}

/**
 * Starts crew runs and keeps their history. Each run is stored as `<id>.json` (summary)
 * plus `<id>.jsonl` (event log), so threads survive a restart.
 */
export class RunManager {
  private runs = new Map<string, Run>();
  private cached: string[] = [];
  /** Checkpoints of runs when no runsDir is configured (tests, in-memory mode). */
  private checkpoints = new Map<string, Checkpoint>();
  private pendingData = new Map<string, { variants: string[] }>();
  /** connectionId -> when its usage limit resets. */
  private limited = new Map<string, number>();

  constructor(
    private config: ConfigStore,
    private projectsDir: string,
    private providerFactory: ProviderFactory,
    private runsDir?: string,
    private sync?: { harness: HarnessSync; memory: ProjectMemory; dataDir: string; previewOrigin: string },
  ) {}

  /** Plugins and skill packs for a request: what gets synced and handed to the crew. */
  private async extras(project: string, request: string) {
    const ws = await Workspace.open(this.projectsDir, project);
    const ext = this.config.extensions;
    const pluginState = { enabled: ext.pluginsEnabled, disabled: ext.pluginsDisabled };
    const plugins = this.sync
      ? pluginContributions(pluginState, {
          project,
          dataDir: this.sync.dataDir,
          previewOrigin: this.sync.previewOrigin,
          options: { browserAnyWebsite: ext.browserAnyWebsite },
        })
      : { servers: [] as McpServer[], instructions: [] as string[] };
    const packs: ActivePack[] = selectPacks(ext.packModes, request, await ws.list());
    const extras: SyncExtras = { servers: plugins.servers, instructions: plugins.instructions, skills: packs.flatMap((p) => p.pack.skills) };
    const servers = [...this.config.sync.mcpServers, ...plugins.servers.filter((p) => !this.config.sync.mcpServers.some((u) => u.name === p.name))];
    const env = { ...this.config.sync.env, ...Object.assign({}, ...plugins.servers.map((s) => s.fixedEnv ?? {})) };
    return { ws, extras, packs, servers, env, pluginNames: this.sync ? enabledPlugins(pluginState).map((p) => p.name) : [] };
  }

  /** Writes shared instructions, memory, MCP servers and skills into the project's harness files. */
  async syncProject(project: string, request = "") {
    if (!this.sync) return [];
    const { ws, extras } = await this.extras(project, request);
    return this.sync.harness.apply(project, ws, this.config.sync, extras);
  }

  private async saveCheckpoint(id: string, cp: Checkpoint): Promise<void> {
    if (!this.runsDir) return void this.checkpoints.set(id, cp);
    await writeFile(path.join(this.runsDir, `${id}.checkpoint.json`), JSON.stringify(cp));
  }

  private async loadCheckpoint(id: string): Promise<Checkpoint | undefined> {
    if (!this.runsDir) return this.checkpoints.get(id);
    try {
      return JSON.parse(await readFile(path.join(this.runsDir, `${id}.checkpoint.json`), "utf8")) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  /**
   * Restores the files a run changed. Files edited again since then are reported as
   * conflicts and left alone unless `force` is set.
   */
  async undo(id: string, force = false): Promise<UndoResult> {
    const run = this.get(id);
    if (run.status === "running") throw new HttpError(409, "stop the crew before undoing its work");
    if (run.undoneAt) throw new HttpError(409, "this thread was already undone");
    const cp = await this.loadCheckpoint(id);
    if (!cp) throw new HttpError(404, "this thread has no checkpoint to undo");
    const ws = await Workspace.open(this.projectsDir, run.project);

    const conflicts: string[] = [];
    for (const f of cp.files) if (hashText(await ws.tryRead(f.path)) !== f.afterHash) conflicts.push(f.path);
    if (conflicts.length && !force) return { restored: [], conflicts, skipped: cp.skipped };

    const restored: string[] = [];
    for (const f of cp.files) {
      if (f.before === null) await ws.remove(f.path);
      else await ws.write(f.path, f.before);
      restored.push(f.path);
    }
    run.undoneAt = Date.now();
    await this.saveSummary(run);
    return { restored, conflicts: [], skipped: cp.skipped };
  }

  /** Loads stored run summaries. Runs that were still going when MultiCode stopped are closed. */
  async load(): Promise<void> {
    if (!this.runsDir) return;
    await mkdir(this.runsDir, { recursive: true });
    for (const name of await readdir(this.runsDir)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !RUN_ID.test(id)) continue;
      try {
        const s = JSON.parse(await readFile(path.join(this.runsDir, name), "utf8")) as RunSummary;
        if (s.id !== id || typeof s.project !== "string" || typeof s.prompt !== "string") continue;
        const run: Run = { ...s, events: null, listeners: new Set() };
        if (run.status === "running") {
          run.status = "error";
          run.endedAt = Date.now();
          const e: RunEvent = { type: "run.error", error: "MultiCode was stopped while the crew was working.", at: run.endedAt };
          await appendFile(this.logPath(id), JSON.stringify(e) + "\n");
          await this.saveSummary(run);
        }
        this.runs.set(id, run);
      } catch {
        /* skip unreadable entries */
      }
    }
  }

  private logPath(id: string): string {
    return path.join(this.runsDir!, `${id}.jsonl`);
  }

  private async saveSummary(run: Run): Promise<void> {
    if (!this.runsDir) return;
    await writeFile(path.join(this.runsDir, `${run.id}.json`), JSON.stringify(summaryOf(run)));
  }

  /** The crew to use: the configured one, or every connection if none is configured yet. */
  effectiveCrew(): CrewMember[] {
    if (this.config.crew.length) return this.config.crew;
    return this.config.connections.map((c: Connection, i) => ({
      id: `auto-${c.id}`,
      name: c.label,
      role: i === 0 ? "architect" : "builder",
      connectionId: c.id,
    }));
  }

  list(project?: string): RunSummary[] {
    return [...this.runs.values()]
      .filter((r) => !project || r.project === project)
      .map(summaryOf)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, "run not found");
    return run;
  }

  /** All events of a run, reading the stored log when needed. */
  async events(id: string): Promise<RunEvent[]> {
    const run = this.get(id);
    if (run.events) return run.events;
    let events: RunEvent[] = [];
    if (this.runsDir) {
      const text = await readFile(this.logPath(id), "utf8").catch(() => "");
      events = text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as RunEvent];
          } catch {
            return [];
          }
        });
    }
    run.events = events;
    this.cached.push(id);
    while (this.cached.length > MAX_CACHED_EVENT_LOGS) {
      const old = this.runs.get(this.cached.shift()!);
      if (old && old.status !== "running") old.events = null;
    }
    return events;
  }

  subscribe(id: string, listener: Listener): () => void {
    const run = this.get(id);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancel(id: string): void {
    const run = this.get(id);
    if (run.status === "running") run.controller?.abort();
  }

  /** The free model that takes over when an account hits its limit (needs OpenCode). */
  private async freeFallback(): Promise<ResolvedMember | undefined> {
    const f = this.config.settings.freeFallback;
    if (!f.enabled || !(await findBinary(CLI_BINARIES["opencode-cli"]))) return undefined;
    const connection: Connection = { id: "free-fallback", kind: "opencode-cli", label: `${connectionName("opencode-cli", undefined, f.model)}`, defaultModel: f.model };
    return { id: "free-fallback", name: `${connection.label} · fallback`, role: "builder", connectionId: connection.id, connection, provider: this.providerFactory(connection), agents: 1 };
  }

  /** Accounts currently out of quota: connectionId -> reset time. */
  limitsView(): Record<string, number> {
    const now = Date.now();
    return Object.fromEntries([...this.limited.entries()].filter(([, until]) => until > now));
  }

  clearLimit(connectionId: string): void {
    this.limited.delete(connectionId);
  }

  private sandboxDir(runId: string, name = "main"): string {
    if (!this.sync) throw new HttpError(500, "sandboxes need a data folder");
    return path.join(this.sync.dataDir, "sandboxes", runId, name);
  }

  /** Where a sandbox or design variant can be previewed from. */
  sandboxRoot(runId: string, name: string): string {
    if (!RUN_ID.test(runId) || !/^[a-z0-9-]{1,40}$/.test(name)) throw new HttpError(404, "not found");
    return this.sandboxDir(runId, name);
  }

  async start(project: string, prompt: string, mode: RunMode = "build"): Promise<RunSummary> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "prompt is required");
    if (prompt.length > 20_000) throw new HttpError(400, "prompt is too long");
    if (mode !== "build" && mode !== "design") throw new HttpError(400, "mode must be build or design");
    if ([...this.runs.values()].some((r) => r.project === project && (r.status === "running" || r.pending)))
      throw new HttpError(409, "this project has a crew at work or changes waiting for your review");

    const settings = this.config.settings;
    const sandboxed = mode === "design" || settings.safety === "sandbox";
    if (sandboxed && !this.sync) throw new HttpError(400, "sandboxes need a data folder");
    const projectWs = await Workspace.open(this.projectsDir, project);
    const members: ResolvedMember[] = this.effectiveCrew().flatMap((m) => {
      const connection = this.config.connection(m.connectionId);
      return connection ? [{ ...m, connection, provider: this.providerFactory(connection) }] : [];
    });
    const roles = (() => {
      try {
        return assignRoles(members);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    })();
    const fallback = await this.freeFallback();
    const isProtected = makeProtector(settings.protectedPaths);

    const history = this.list(project)
      .filter((r) => r.status === "done" && !r.pending)
      .slice(0, 5)
      .reverse()
      .map((r) => r.prompt.slice(0, 500));

    // Every harness sees the same instructions, memory, tools and skills before the crew starts.
    const ctx = await this.extras(project, mode === "design" ? `${prompt} design ui web` : prompt);
    if (this.sync)
      await this.sync.harness
        .apply(project, ctx.ws, this.config.sync, ctx.extras)
        .catch((err: Error) => console.error(`Sync failed for ${project}:`, err.message));

    const run: Run = {
      id: randomUUID(),
      project,
      prompt: prompt.trim(),
      status: "running",
      startedAt: Date.now(),
      mode,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
    };
    if (this.runsDir) {
      await mkdir(this.runsDir, { recursive: true });
      run.log = createWriteStream(this.logPath(run.id), { flags: "a" });
      run.log.on("error", (err) => console.error(`Could not write run log ${run.id}:`, err.message));
      await this.saveSummary(run);
    }
    this.runs.set(run.id, run);

    const emit = (e: RunEvent) => {
      if (run.events && run.events.length < MAX_EVENTS) run.events.push(e);
      run.log?.write(JSON.stringify(e) + "\n");
      for (const l of run.listeners) l(e);
    };
    emit({ type: "run.started", runId: run.id, project, prompt: run.prompt, at: run.startedAt });
    emit({
      type: "context",
      skills: ctx.packs.flatMap((p) => p.pack.skills.map((s) => s.name)),
      plugins: ctx.pluginNames,
      fallback: fallback ? { id: fallback.id, name: fallback.name } : undefined,
      safety: settings.safety,
      economy: settings.economy,
    });

    // Who wrote which file, for the memory graph.
    const wrote = new Map<string, Set<string>>();
    const track = (e: RunEvent) => {
      if (e.type === "file.changed") wrote.set(e.memberId, (wrote.get(e.memberId) ?? new Set()).add(e.path));
    };

    const finish = async (status: RunSummary["status"], last: RunEvent) => {
      run.status = status;
      run.endedAt = Date.now();
      emit(last);
      run.log?.end();
      run.log = undefined;
      this.cached.push(run.id);
      await this.saveSummary(run).catch((err: Error) => console.error(`Could not save run ${run.id}:`, err.message));
    };

    const common = {
      prompt: run.prompt,
      history,
      roles,
      settings,
      mcpServers: ctx.servers,
      env: ctx.env,
      skillText: inlineSkills(ctx.packs),
      fallback,
      limited: this.limited,
      isProtected,
      emit: (e: RunEvent) => {
        track(e);
        if (e.type === "member.limit") void this.saveLimits();
        emit(e);
      },
      signal: run.controller!.signal,
    };

    const work = async () => {
      if (mode === "design") {
        // One sandbox per variant, one variant per builder (at least two, at most four).
        const count = Math.min(4, Math.max(2, roles.builders.length));
        const variants = await Promise.all(
          DESIGN_DIRECTIONS.slice(0, count).map(async (d, i) => {
            const id = `v${i + 1}`;
            const dir = this.sandboxDir(run.id, id);
            await copyToSandbox(projectWs.root, dir, isProtected);
            const member = roles.builders[i % roles.builders.length]!;
            return { variant: { id, title: d.title, direction: d.direction, memberId: member.id }, member, workspace: new Workspace(dir) };
          }),
        );
        const { summary, done } = await runDesign({ ...common, variants });
        run.pending = "design";
        await this.savePending(run.id, { variants: done });
        emit({ type: "approval", kind: "design" });
        await finish("done", { type: "run.done", summary, changedFiles: [], at: Date.now() });
        return;
      }

      let ws = projectWs;
      if (sandboxed) {
        await copyToSandbox(projectWs.root, this.sandboxDir(run.id), isProtected);
        ws = new Workspace(this.sandboxDir(run.id));
      }
      const { summary, changedFiles, checkpoint } = await runCrew({ ...common, workspace: ws });
      if (checkpoint.files.length) {
        await this.saveCheckpoint(run.id, checkpoint).catch((err: Error) => console.error("Could not save checkpoint:", err.message));
        if (!sandboxed) run.canUndo = true;
      }
      if (sandboxed && changedFiles.length) {
        run.pending = "sandbox";
        emit({ type: "approval", kind: "sandbox" });
      } else if (sandboxed) await rm(path.dirname(this.sandboxDir(run.id)), { recursive: true, force: true });
      if (this.sync && settings.safety !== "readonly") await this.remember(project, run, summary, changedFiles, wrote, members, ctx);
      await finish("done", { type: "run.done", summary, changedFiles, at: Date.now() });
    };

    work().catch(async (err: Error) => {
      const aborted = run.controller!.signal.aborted;
      if (sandboxed) await rm(path.dirname(this.sandboxDir(run.id)), { recursive: true, force: true }).catch(() => {});
      return finish(aborted ? "cancelled" : "error", { type: "run.error", error: aborted ? "Cancelled" : err.message, at: Date.now() });
    });

    return summaryOf(run);
  }

  /** Project memory + memory graph + a fresh harness sync after a finished run. */
  private async remember(
    project: string,
    run: Run,
    summary: string,
    changedFiles: string[],
    wrote: Map<string, Set<string>>,
    members: ResolvedMember[],
    ctx: Awaited<ReturnType<RunManager["extras"]>>,
  ) {
    if (!this.sync) return;
    await this.sync.memory.add(project, { at: Date.now(), prompt: run.prompt, summary });
    const ext = this.config.extensions;
    if (enabledPlugins({ enabled: ext.pluginsEnabled, disabled: ext.pluginsDisabled }).some((p) => p.id === "memory-graph")) {
      const agents = [...wrote.entries()].map(([id, files]) => {
        const m = members.find((x) => x.id === id);
        return { name: m?.name ?? id, harness: m ? HARNESS_NAMES[m.connection.kind] : "OpenCode", files: [...files] };
      });
      await recordRun(memoryGraphFile(this.sync.dataDir, project), { project, prompt: run.prompt, summary, files: changedFiles, agents, at: Date.now() }).catch(
        (err: Error) => console.error("Could not update the memory graph:", err.message),
      );
    }
    await this.sync.harness.apply(project, ctx.ws, this.config.sync, ctx.extras).catch(() => {});
  }

  private async savePending(id: string, data: { variants: string[] }) {
    if (this.runsDir) await writeFile(path.join(this.runsDir, `${id}.pending.json`), JSON.stringify(data));
    this.pendingData.set(id, data);
  }

  private async loadPending(id: string): Promise<{ variants: string[] } | undefined> {
    if (this.pendingData.has(id)) return this.pendingData.get(id);
    if (!this.runsDir) return undefined;
    try {
      return JSON.parse(await readFile(path.join(this.runsDir, `${id}.pending.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  /**
   * Applies a sandbox run (or the chosen design variant) to the real project. Files you edited
   * since the run started are reported as conflicts and left alone unless `force` is set.
   */
  async apply(id: string, variant?: string, force = false): Promise<UndoResult & { applied: string[] }> {
    const run = this.get(id);
    if (!run.pending) throw new HttpError(409, "nothing is waiting to be applied for this thread");
    const project = await Workspace.open(this.projectsDir, run.project);
    const isProtected = makeProtector(this.config.settings.protectedPaths);
    let files: { path: string; before: string | null | undefined; content: string | undefined }[] = [];

    if (run.pending === "sandbox") {
      const cp = await this.loadCheckpoint(id);
      if (!cp) throw new HttpError(404, "this sandbox has no recorded changes");
      const sandbox = new Workspace(this.sandboxDir(id));
      files = await Promise.all(cp.files.map(async (f) => ({ path: f.path, before: f.before, content: await sandbox.tryRead(f.path) })));
    } else {
      const pending = await this.loadPending(id);
      if (!variant || !pending?.variants.includes(variant)) throw new HttpError(400, "pick one of the finished designs");
      const sandbox = new Workspace(this.sandboxRoot(id, variant));
      const all = new Set([...(await sandbox.list()), ...(await project.list())]);
      for (const p of all) {
        if (isProtected(p)) continue;
        const [mine, theirs] = [await project.tryRead(p), await sandbox.tryRead(p)];
        if (mine !== theirs) files.push({ path: p, before: undefined, content: theirs });
      }
    }

    const conflicts: string[] = [];
    if (run.pending === "sandbox")
      for (const f of files) if (hashText(await project.tryRead(f.path)) !== hashText(f.before ?? null)) conflicts.push(f.path);
    if (conflicts.length && !force) return { applied: [], restored: [], conflicts, skipped: [] };

    // Checkpoint of the real project first, so applying can be undone like any other run.
    const checkpoint: Checkpoint = { files: [], skipped: [] };
    const applied: string[] = [];
    for (const f of files) {
      if (isProtected(f.path)) continue;
      checkpoint.files.push({ path: f.path, before: (await project.tryRead(f.path)) ?? null, afterHash: hashText(f.content ?? null) });
      if (f.content === undefined) await project.remove(f.path);
      else await project.write(f.path, f.content);
      applied.push(f.path);
    }
    await this.saveCheckpoint(id, checkpoint);
    run.canUndo = applied.length > 0;
    run.pending = undefined;
    run.resolution = "applied";
    await rm(path.dirname(this.sandboxDir(id)), { recursive: true, force: true });
    await this.saveSummary(run);
    return { applied, restored: [], conflicts: [], skipped: [] };
  }

  async discard(id: string): Promise<void> {
    const run = this.get(id);
    if (!run.pending) throw new HttpError(409, "nothing is waiting for review in this thread");
    run.pending = undefined;
    run.resolution = "discarded";
    await rm(path.dirname(this.sandboxDir(id)), { recursive: true, force: true });
    await this.saveSummary(run);
  }

  private async saveLimits(): Promise<void> {
    if (!this.sync) return;
    await writeFile(path.join(this.sync.dataDir, "limits.json"), JSON.stringify(this.limitsView())).catch(() => {});
  }

  async loadLimits(): Promise<void> {
    if (!this.sync) return;
    try {
      const data = JSON.parse(await readFile(path.join(this.sync.dataDir, "limits.json"), "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(data)) if (typeof v === "number" && v > Date.now()) this.limited.set(k, v);
    } catch {
      /* none saved */
    }
  }
}
