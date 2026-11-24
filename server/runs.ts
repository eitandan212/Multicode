import { randomUUID } from "node:crypto";
import type { ConfigStore, Connection } from "./config.js";
import { HttpError } from "./config.js";
import { assignRoles, runCrew, type ResolvedMember } from "./crew/orchestrator.js";
import type { ProviderFactory } from "./providers/registry.js";
import type { CrewMember, RunEvent, RunSummary } from "./shared.js";
import { Workspace } from "./workspace.js";

type Listener = (e: RunEvent) => void;

interface Run extends RunSummary {
  events: RunEvent[];
  listeners: Set<Listener>;
  controller: AbortController;
}

const MAX_RUNS_KEPT = 50;
const MAX_EVENTS = 20_000;

export class RunManager {
  private runs = new Map<string, Run>();

  constructor(
    private config: ConfigStore,
    private projectsDir: string,
    private providerFactory: ProviderFactory,
  ) {}

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
      .map(({ id, project, prompt, status, startedAt }) => ({ id, project, prompt, status, startedAt }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, "run not found");
    return run;
  }

  subscribe(id: string, listener: Listener): () => void {
    const run = this.get(id);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancel(id: string): void {
    const run = this.get(id);
    if (run.status === "running") run.controller.abort();
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
    this.runs.set(run.id, run);
    this.prune();

    const emit = (e: RunEvent) => {
      if (run.events.length < MAX_EVENTS) run.events.push(e);
      for (const l of run.listeners) l(e);
    };
    emit({ type: "run.started", runId: run.id, project, prompt: run.prompt, at: run.startedAt });

    runCrew({
      prompt: run.prompt,
      history,
      workspace,
      roles,
      settings: this.config.settings,
      emit,
      signal: run.controller.signal,
    })
      .then(({ summary, changedFiles }) => {
        run.status = "done";
        emit({ type: "run.done", summary, changedFiles, at: Date.now() });
      })
      .catch((err: Error) => {
        run.status = run.controller.signal.aborted ? "cancelled" : "error";
        emit({ type: "run.error", error: run.controller.signal.aborted ? "Cancelled" : err.message, at: Date.now() });
      });

    const { events: _e, listeners: _l, controller: _c, ...summary } = run;
    return summary;
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter((r) => r.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
    while (this.runs.size > MAX_RUNS_KEPT && finished.length) this.runs.delete(finished.shift()!.id);
  }
}
