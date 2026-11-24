import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RunEvent, RunSummary } from "../../server/shared";
import { api, type AppState } from "./api";
import { ConnectionsDialog } from "./components/ConnectionsDialog";
import { CrewPanel } from "./components/CrewPanel";
import { Mission } from "./components/Mission";
import { Workspace } from "./components/Workspace";
import { emptyRun, reduceRun, type RunView } from "./runState";

type Pane = "crew" | "mission" | "workspace";

type RunAction = { kind: "reset"; run: RunView | null } | { kind: "event"; event: RunEvent };

function runReducer(state: RunView | null, a: RunAction): RunView | null {
  if (a.kind === "reset") return a.run;
  return state ? reduceRun(state, a.event) : state;
}

const LAST_PROJECT = "multicode:lastProject";

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, dispatch] = useReducer(runReducer, null);
  const [showConnections, setShowConnections] = useState(false);
  const [pane, setPane] = useState<Pane>("mission");
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setState(await api.state());
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Pick (or create) a project once state has loaded.
  useEffect(() => {
    if (!state || project) return;
    const last = readLastProject();
    const existing = state.projects.find((p) => p.name === last) ?? state.projects[0];
    if (existing) setProject(existing.name);
    else
      void api.createProject("my-first-app").then(async (p) => {
        await reload();
        setProject(p.name);
      });
  }, [state, project, reload]);

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(LAST_PROJECT, project);
    } catch {
      /* storage unavailable: fine */
    }
    dispatch({ kind: "reset", run: null });
    api.runs(project).then((list) => {
      setRuns(list);
      if (list[0]) dispatch({ kind: "reset", run: emptyRun(list[0].id, list[0].prompt) });
    });
  }, [project]);

  const bumpPreview = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => setRefreshKey((k) => k + 1), 600);
  }, []);

  // Stream the selected run's events (replays history first).
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    return api.events(runId, (event) => {
      dispatch({ kind: "event", event });
      if (event.type === "file.changed" || event.type === "run.done") bumpPreview();
      if (event.type === "run.done" || event.type === "run.error") {
        setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, status: event.type === "run.done" ? "done" : "error" } : r)));
        void reload();
      }
    });
  }, [runId, bumpPreview, reload]);

  const busyMembers = useMemo(
    () => new Set(run?.streams.filter((s) => s.status === "live").map((s) => s.memberId) ?? []),
    [run?.streams],
  );

  const startRun = async (prompt: string) => {
    if (!project) return;
    const summary = await api.startRun(project, prompt);
    setRuns((rs) => [summary, ...rs]);
    dispatch({ kind: "reset", run: emptyRun(summary.id, summary.prompt) });
    setPane("mission");
  };

  const newProject = async () => {
    const name = window.prompt("Project name (letters, digits, - or _)");
    if (!name) return;
    try {
      const p = await api.createProject(name.trim());
      await reload();
      setProject(p.name);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };

  if (!state) {
    return (
      <div className="boot">
        {loadError ? (
          <p className="err-text">MultiCode's server isn't reachable: {loadError}. Start it with <code>npm start</code>.</p>
        ) : (
          <p className="muted">Loading MultiCode…</p>
        )}
      </div>
    );
  }

  const canRun = state.connections.length > 0 && Boolean(project);

  return (
    <div className="app" data-pane={pane}>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
            <path d="M5 23V9l6 8 6-8v14" stroke="var(--c1)" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M27.5 12a5 5 0 1 0 0 8" stroke="var(--accent)" strokeWidth="2.8" fill="none" strokeLinecap="round" />
          </svg>
          <span>MultiCode</span>
        </div>
        <div className="project-picker">
          <label className="sr-only" htmlFor="project">
            Project
          </label>
          <select id="project" value={project ?? ""} onChange={(e) => setProject(e.target.value)}>
            {state.projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small ghost" onClick={newProject}>
            New project
          </button>
        </div>
        <button className="btn small" onClick={() => setShowConnections(true)}>
          Connections
        </button>
      </header>

      <main className="layout">
        <aside className="pane pane-crew">
          <CrewPanel state={state} busyMembers={busyMembers} onChanged={reload} onOpenConnections={() => setShowConnections(true)} />
        </aside>
        <div className="pane pane-mission">
          {project && (
            <Mission
              run={run}
              crew={state.effectiveCrew}
              canRun={canRun}
              project={project}
              pastRuns={runs.map((r) => ({ id: r.id, prompt: r.prompt }))}
              onPickRun={(id) => {
                const r = runs.find((x) => x.id === id);
                if (r) dispatch({ kind: "reset", run: emptyRun(r.id, r.prompt) });
              }}
              onSubmit={startRun}
              onCancel={() => run && void api.cancelRun(run.id)}
            />
          )}
        </div>
        <div className="pane pane-workspace">
          {project && <Workspace project={project} refreshKey={refreshKey} changed={run?.changed ?? []} />}
        </div>
      </main>

      <nav className="mobile-tabs" aria-label="Sections">
        {(["crew", "mission", "workspace"] as Pane[]).map((p) => (
          <button key={p} className={pane === p ? "is-active" : ""} onClick={() => setPane(p)}>
            {p === "crew" ? "Crew" : p === "mission" ? "Mission" : "Preview"}
          </button>
        ))}
      </nav>

      {showConnections && <ConnectionsDialog state={state} onClose={() => setShowConnections(false)} onChanged={reload} />}
    </div>
  );
}
