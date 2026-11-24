import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigStore, Connection } from "./config.js";
import { HttpError } from "./config.js";
import { assignRoles, runCrew, type ResolvedMember } from "./crew/orchestrator.js";
import type { ProviderFactory } from "./providers/registry.js";
import type { CrewMember, RunEvent, RunSummary } from "./shared.js";
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

const summaryOf = ({ id, project, prompt, status, startedAt, endedAt }: Run): RunSummary => ({
  id,
  project,
  prompt,
  status,
  startedAt,
  endedAt,
});

/**
 * Starts crew runs and keeps their history. Each run is stored as `<id>.json` (summary)
 * plus `<id>.jsonl` (event log), so threads survive a restart.
 */
export class RunManager {
  private runs = new Map<string, Run>();
  private cached: string[] = [];

  constructor(
    private config: ConfigStore,
    private projectsDir: string,
    private providerFactory: ProviderFactory,
    private runsDir?: string,
  ) {}

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

  async start(project: string, prompt: string): Promise<RunSummary> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "prompt is required");
    if (prompt.length > 20_000) throw new HttpError(400, "prompt is too long");
    if ([...this.runs.values()].some((r) => r.project === project && r.status === "running"))
      throw new HttpError(409, "a crew is already working on this project");

    const workspace = await Workspace.open(this.projectsDir, project);
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

    const history = this.list(project)
      .filter((r) => r.status === "done")
      .slice(0, 5)
      .reverse()
      .map((r) => r.prompt.slice(0, 500));

    const run: Run = {
      id: randomUUID(),
      project,
      prompt: prompt.trim(),
      status: "running",
      startedAt: Date.now(),
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

    const finish = async (status: RunSummary["status"], last: RunEvent) => {
      run.status = status;
      run.endedAt = Date.now();
      emit(last);
      run.log?.end();
      run.log = undefined;
      this.cached.push(run.id);
      await this.saveSummary(run).catch((err: Error) => console.error(`Could not save run ${run.id}:`, err.message));
    };

    runCrew({
      prompt: run.prompt,
      history,
      workspace,
      roles,
      settings: this.config.settings,
      emit,
      signal: run.controller!.signal,
    })
      .then(({ summary, changedFiles }) => finish("done", { type: "run.done", summary, changedFiles, at: Date.now() }))
      .catch((err: Error) => {
        const aborted = run.controller!.signal.aborted;
        return finish(aborted ? "cancelled" : "error", { type: "run.error", error: aborted ? "Cancelled" : err.message, at: Date.now() });
      });

    return summaryOf(run);
  }
}
