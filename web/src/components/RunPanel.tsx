import { useEffect, useRef, useState } from "react";
import type { ProjectScript, ScriptState } from "../../../server/scripts";
import { api } from "../api";
import { Icon, Spinner } from "./Icon";

/**
 * The Run tab (as T3 Code's project scripts): your commands for this project, one click to start,
 * live output, Stop, and a link when a dev server prints its address.
 */
export function RunPanel({ project }: { project: string }) {
  const [scripts, setScripts] = useState<ProjectScript[]>([]);
  const [suggested, setSuggested] = useState(false);
  const [running, setRunning] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [out, setOut] = useState<ScriptState | null>(null);
  const [editing, setEditing] = useState<ProjectScript[] | null>(null);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const load = () =>
    api
      .scripts(project)
      .then((r) => {
        setScripts(r.scripts);
        setSuggested(r.suggested);
        setRunning(r.running);
        setCurrent((c) => (c && r.scripts.some((s) => s.id === c) ? c : (r.running[0] ?? r.scripts[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setOut(null);
    setEditing(null);
    setError("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Output of the chosen script: only new lines are fetched, every second while it runs.
  useEffect(() => {
    if (!current) return;
    let live = true;
    let have = 0;
    let lines: string[] = [];
    setOut(null);
    const tick = async () => {
      try {
        const s = await api.scriptOutput(project, current, have);
        if (!live) return;
        lines = (have === 0 ? s.lines : [...lines, ...s.lines]).slice(-2000);
        have = s.total;
        setOut({ ...s, lines });
        setRunning((r) => (s.status === "running" ? [...new Set([...r, current])] : r.filter((x) => x !== current)));
      } catch {
        /* the next tick tries again */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 1000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [project, current]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [out?.total]);

  const run = async (id: string) => {
    setError("");
    setCurrent(id);
    try {
      await api.runScript(project, id);
      setRunning((r) => [...new Set([...r, id])]);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = async (id: string) => {
    await api.stopScript(project, id).catch((e: Error) => setError(e.message));
  };
  const save = async () => {
    if (!editing) return;
    setError("");
    try {
      const r = await api.saveScripts(project, editing.filter((s) => s.name.trim() || s.command.trim()));
      setScripts(r.scripts);
      setSuggested(false);
      setEditing(null);
      if (!r.scripts.some((s) => s.id === current)) setCurrent(r.scripts[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (editing)
    return (
      <div className="run-panel">
        <p className="muted small">Commands run in the project folder on this computer, like in a terminal.</p>
        <div className="run-edit">
          {editing.map((s, i) => (
            <div key={i} className="run-edit-row">
              <input
                value={s.name}
                placeholder="Name"
                aria-label="Script name"
                maxLength={40}
                onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className="mono"
                value={s.command}
                placeholder="npm run dev"
                aria-label="Command"
                maxLength={500}
                onChange={(e) => setEditing(editing.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))}
              />
              <button className="icon-btn" aria-label="Remove" onClick={() => setEditing(editing.filter((_, j) => j !== i))}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
          <button className="btn small ghost" onClick={() => setEditing([...editing, { id: "", name: "", command: "" }])}>
            <Icon name="plus" size={13} /> Add a script
          </button>
        </div>
        {error && <p className="err-text small">{error}</p>}
        <div className="form-actions">
          <button className="btn ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    );

  const isRunning = (id: string) => running.includes(id);
  return (
    <div className="run-panel">
      <div className="run-scripts">
        {scripts.map((s) => (
          <div key={s.id} className={`run-script ${current === s.id ? "is-active" : ""}`}>
            <button className="run-script-name" onClick={() => setCurrent(s.id)} title={s.command}>
              {isRunning(s.id) ? <Spinner size={11} /> : <span className={`run-dot is-${current === s.id ? (out?.status ?? "idle") : "idle"}`} />}
              {s.name}
            </button>
            {isRunning(s.id) ? (
              <button className="icon-btn tiny" aria-label={`Stop ${s.name}`} title="Stop" onClick={() => void stop(s.id)}>
                <Icon name="stop" size={11} />
              </button>
            ) : (
              <button className="icon-btn tiny run-play" aria-label={`Run ${s.name}`} title={`Run: ${s.command}`} onClick={() => void run(s.id)}>
                <Icon name="play" size={12} />
              </button>
            )}
          </div>
        ))}
        <button className="icon-btn" title="Edit scripts" aria-label="Edit scripts" onClick={() => setEditing(scripts.length ? scripts : [{ id: "", name: "Dev", command: "npm run dev" }])}>
          <Icon name="pencil" size={13} />
        </button>
      </div>
      {scripts.length === 0 && (
        <p className="ws-empty">
          No scripts yet. Add your commands (a dev server, tests, a build) and run them with one click.
        </p>
      )}
      {suggested && scripts.length > 0 && <p className="muted small">Suggested from package.json. Edit to make them yours.</p>}
      {error && <p className="err-text small">{error}</p>}
      {current && out && (
        <>
          {(out.url || out.status !== "idle") && (
            <div className="run-status">
              <span className={`run-state is-${out.status}`}>
                {out.status === "running" ? "Running" : out.status === "done" ? "Finished" : out.status === "stopped" ? "Stopped" : out.status === "failed" ? `Failed${out.exitCode != null ? ` (exit ${out.exitCode})` : ""}` : ""}
              </span>
              {out.url && (
                <a className="btn small" href={out.url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={12} /> {out.url.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          )}
          <pre
            ref={logRef}
            className="run-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {out.lines.length ? out.lines.join("\n") : <span className="muted">Press ▶ to run it. Its output shows here.</span>}
          </pre>
        </>
      )}
    </div>
  );
}
