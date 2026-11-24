import { useEffect, useMemo, useState } from "react";
import type { ProjectInfo, RunSummary } from "../../../server/shared";
import { Icon, Spinner } from "./Icon";

interface Props {
  projects: ProjectInfo[];
  runs: RunSummary[];
  project: string | null;
  runId: string | null;
  onSelectProject: (name: string) => void;
  onSelectRun: (run: RunSummary) => void;
  onNewThread: () => void;
  onNewProject: () => void;
  onOpenConnections: () => void;
  onOpenCrew: () => void;
  onOpenSync: () => void;
  onCollapse: () => void;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");
  const [showWorking, setShowWorking] = useState(true);
  const working = p.runs.filter((r) => r.status === "running");
  const now = useNow(working.length > 0);
  const q = query.trim().toLowerCase();

  const byProject = useMemo(() => {
    const map = new Map<string, RunSummary[]>();
    for (const r of p.runs) map.set(r.project, [...(map.get(r.project) ?? []), r]);
    return map;
  }, [p.runs]);

  const projects = p.projects.filter(
    (pr) => !q || pr.name.toLowerCase().includes(q) || (byProject.get(pr.name) ?? []).some((r) => r.prompt.toLowerCase().includes(q)),
  );

  return (
    <nav className="sidebar" aria-label="Projects and threads">
      <div className="sb-head">
        <button className="icon-btn" onClick={p.onCollapse} aria-label="Hide sidebar" title="Hide sidebar">
          <Icon name="sidebar" />
        </button>
        <span className="sb-brand">
          <b>Multi</b>Code
        </span>
      </div>

      <div className="sb-search">
        <label className="search-field">
          <Icon name="search" />
          <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search threads" />
        </label>
        <button className="icon-btn" onClick={p.onNewProject} title="New project" aria-label="New project">
          <Icon name="folderPlus" />
        </button>
        <button className="icon-btn" onClick={p.onNewThread} title="New thread" aria-label="New thread">
          <Icon name="compose" />
        </button>
      </div>

      <div className="sb-list">
        {projects.length === 0 && <p className="sb-empty">{q ? "No matches" : "No projects yet"}</p>}
        {projects.map((pr) => {
          const threads = (byProject.get(pr.name) ?? []).filter((r) => !q || r.prompt.toLowerCase().includes(q) || pr.name.includes(q));
          const open = pr.name === p.project || Boolean(q);
          return (
            <div key={pr.name} className="sb-project">
              <button className={`sb-project-row ${pr.name === p.project ? "is-current" : ""}`} onClick={() => p.onSelectProject(pr.name)}>
                <Icon name="folder" size={15} />
                <span className="truncate">{pr.name}</span>
                {threads.length > 0 && <span className="sb-count">{threads.length}</span>}
              </button>
              {open &&
                threads.map((r) => (
                  <button
                    key={r.id}
                    className={`sb-thread ${r.id === p.runId ? "is-active" : ""}`}
                    onClick={() => p.onSelectRun(r)}
                    title={r.prompt}
                  >
                    <span className="truncate">{r.prompt}</span>
                    {r.status === "running" ? <Spinner size={11} /> : r.status === "error" ? <span className="dot bad" /> : null}
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      <div className="sb-groups">
        <button className="sb-group" onClick={() => setShowWorking(!showWorking)} aria-expanded={showWorking}>
          <span>Working</span>
          <span className="sb-count">{working.length}</span>
          <Icon name={showWorking ? "chevronDown" : "chevron"} size={14} />
        </button>
        {showWorking &&
          working.map((r) => (
            <button key={r.id} className={`sb-card ${r.id === p.runId ? "is-active" : ""}`} onClick={() => p.onSelectRun(r)}>
              <span className="sb-card-top">
                <span className="muted truncate">{r.project}</span>
                <span className="working-tag">
                  <Spinner size={11} /> Working {elapsed(now - r.startedAt)}
                </span>
              </span>
              <span className="sb-card-title truncate">{r.prompt}</span>
            </button>
          ))}
      </div>

      <div className="sb-foot">
        <button className="icon-btn" onClick={p.onOpenConnections} title="Connections" aria-label="Connections">
          <Icon name="plug" />
        </button>
        <button className="icon-btn" onClick={p.onOpenCrew} title="Crew" aria-label="Crew">
          <Icon name="users" />
        </button>
        <button className="icon-btn" onClick={p.onOpenSync} title="Sync across harnesses" aria-label="Sync across harnesses">
          <Icon name="sync" />
        </button>
      </div>
    </nav>
  );
}
