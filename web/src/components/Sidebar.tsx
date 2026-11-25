import { useEffect, useMemo, useState } from "react";
import type {
  ConnectionView,
  ProjectInfo,
  RunSummary,
} from "../../../server/shared";
import { Icon, Spinner } from "./Icon";
import { Lockup } from "./Logo";
import { ProviderLogo } from "./ProviderLogo";

interface Props {
  projects: ProjectInfo[];
  runs: RunSummary[];
  connections: ConnectionView[];
  project: string | null;
  runId: string | null;
  onSelectRun: (run: RunSummary) => void;
  onSelectProject: (name: string) => void;
  onNewThread: () => void;
  onNewProject: () => void;
  onOpenSettings: (
    section: "connections" | "safety" | "extensions" | "crew",
  ) => void;
  onCollapse: () => void;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "now", "4m", "2h", "3d": the age of a thread, as T3 Code shows it. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** Two-letter project mark on a colour derived from the name. */
export function ProjectBadge({
  name,
  size = 18,
}: {
  name: string;
  size?: number;
}) {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const letters = (
    parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)
  ).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="project-badge"
      style={{ ["--hue" as string]: h, width: size, height: size }}
      aria-hidden
    >
      {letters}
    </span>
  );
}

const SETTLED_KEY = "multicode:settled";
function loadSettled(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(SETTLED_KEY) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState<Set<string>>(loadSettled);
  const [showSettled, setShowSettled] = useState(false);
  const now = useNow(
    p.runs.some((r) => r.status === "running") ? 1000 : 30_000,
  );
  const q = query.trim().toLowerCase();

  const toggleSettled = (id: string) =>
    setSettled((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(SETTLED_KEY, JSON.stringify([...n].slice(-500)));
      } catch {
        /* storage unavailable: fine for this session */
      }
      return n;
    });

  const matching = useMemo(
    () =>
      [...p.runs]
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter(
          (r) =>
            !q ||
            r.prompt.toLowerCase().includes(q) ||
            r.project.toLowerCase().includes(q),
        ),
    [p.runs, q],
  );
  // Running threads and threads waiting for you never fold away.
  const isSettled = (r: RunSummary) =>
    settled.has(r.id) && r.status !== "running" && !r.pending;
  const working = matching.filter((r) => r.status === "running");
  const inbox = matching.filter((r) => r.status !== "running" && !isSettled(r));
  const done = matching.filter(isSettled);
  const emptyProjects = p.projects.filter(
    (pr) =>
      !p.runs.some((r) => r.project === pr.name) && (!q || pr.name.includes(q)),
  );

  const teamLogo = (r: RunSummary) => {
    if (r.team?.kind === "solo") {
      const solo = r.team;
      const c = p.connections.find((x) => x.id === solo.connectionId);
      if (c)
        return (
          <ProviderLogo
            kind={c.kind}
            acp={c.acp}
            baseUrl={c.baseUrl}
            model={solo.model || c.defaultModel}
            size={13}
          />
        );
    }
    return <Icon name="users" size={13} />;
  };

  const card = (r: RunSummary) => (
    <div
      key={r.id}
      className={`sb-card ${r.id === p.runId ? "is-active" : ""}`}
    >
      <button
        className="sb-card-main"
        onClick={() => p.onSelectRun(r)}
        title={r.prompt}
      >
        <span className="sb-card-top">
          <ProjectBadge name={r.project} size={16} />
          <span className="muted truncate">{r.project}</span>
          <span className="muted sb-age">
            {r.status === "running"
              ? elapsed(now - r.startedAt)
              : ago(r.endedAt ?? r.startedAt, now)}
          </span>
        </span>
        <span className="sb-card-title truncate">{r.prompt}</span>
        <span className="sb-card-meta muted">
          {r.status === "running" ? (
            <span className="working-tag">
              <Spinner size={11} /> Working
            </span>
          ) : r.pending ? (
            <span className="sb-state is-attention">Waiting for you</span>
          ) : r.status === "error" ? (
            <span className="sb-state is-bad">Failed</span>
          ) : r.status === "cancelled" ? (
            <span className="sb-state">Stopped</span>
          ) : (
            <span className="sb-state">
              {r.mode === "design" ? "Designs ready" : "Done"}
            </span>
          )}
          <span className="sb-team">{teamLogo(r)}</span>
        </span>
      </button>
      {r.status !== "running" && !r.pending && (
        <button
          className="sb-settle"
          onClick={() => toggleSettled(r.id)}
          title={
            settled.has(r.id)
              ? "Move back to the inbox"
              : "Settle: fold it away"
          }
          aria-label={settled.has(r.id) ? "Unsettle thread" : "Settle thread"}
        >
          <Icon name={settled.has(r.id) ? "undo" : "check"} size={13} />
        </button>
      )}
    </div>
  );

  return (
    <nav className="sidebar" aria-label="Threads">
      <div className="sb-head">
        <button
          className="icon-btn"
          onClick={p.onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
        >
          <Icon name="sidebar" />
        </button>
        <Lockup size={20} />
      </div>

      <div className="sb-search">
        <label className="search-field">
          <Icon name="search" />
          <input
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search threads"
          />
        </label>
        <button
          className="icon-btn"
          onClick={p.onNewProject}
          title="New project"
          aria-label="New project"
        >
          <Icon name="folder" />
        </button>
        <button
          className="icon-btn"
          onClick={p.onNewThread}
          title={p.project ? `New thread in ${p.project}` : "New thread"}
          aria-label="New thread"
        >
          <Icon name="compose" />
        </button>
      </div>

      <div className="sb-list">
        {working.length > 0 && (
          <>
            <div className="sb-section">Working</div>
            {working.map(card)}
          </>
        )}
        {working.length > 0 && inbox.length > 0 && (
          <div className="sb-section">Threads</div>
        )}
        {inbox.map(card)}
        {emptyProjects.map((pr) => (
          <button
            key={pr.name}
            className={`sb-card sb-card-main sb-project-card ${pr.name === p.project ? "is-active" : ""}`}
            onClick={() => p.onSelectProject(pr.name)}
            title={`New thread in ${pr.name}`}
          >
            <span className="sb-card-top">
              <ProjectBadge name={pr.name} size={16} />
              <span className="muted truncate">{pr.name}</span>
            </span>
            <span className="sb-card-title muted">No threads yet</span>
          </button>
        ))}
        {matching.length === 0 && emptyProjects.length === 0 && (
          <p className="sb-empty">{q ? "No matches" : "No threads yet"}</p>
        )}
      </div>

      <div className="sb-groups">
        <button
          className="sb-group"
          onClick={() => setShowSettled(!showSettled)}
          aria-expanded={showSettled}
        >
          <span>Settled</span>
          <span className="sb-count">{done.length}</span>
          <Icon name={showSettled ? "chevronDown" : "chevron"} size={14} />
        </button>
        {showSettled && <div className="sb-settled">{done.map(card)}</div>}
      </div>

      <div className="sb-foot">
        <button
          className="sb-settings"
          onClick={() => p.onOpenSettings("connections")}
          title="Settings (models, connections, appearance)"
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => p.onOpenSettings("crew")}
          title="Crew & agents"
          aria-label="Crew and agents"
        >
          <Icon name="users" />
        </button>
        <button
          className="icon-btn"
          onClick={() => p.onOpenSettings("extensions")}
          title="Plugins & skills"
          aria-label="Plugins and skills"
        >
          <Icon name="puzzle" />
        </button>
        <button
          className="icon-btn"
          onClick={() => p.onOpenSettings("safety")}
          title="Usage, savings & safety"
          aria-label="Usage, savings and safety"
        >
          <Icon name="shield" />
        </button>
      </div>
    </nav>
  );
}
