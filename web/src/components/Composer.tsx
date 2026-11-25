import { useEffect, useRef, useState } from "react";
import type {
  ConnectionView,
  CrewMember,
  RunMode,
  Settings,
  TeamChoice,
  ManagerView,
} from "../../../server/shared";
import { Icon } from "./Icon";
import { TeamPicker } from "./TeamPicker";
import { usePresence } from "../motion";

interface Props {
  crew: CrewMember[];
  connections: ConnectionView[];
  team: TeamChoice;
  onTeam: (t: TeamChoice) => void;
  manager?: ManagerView | null;
  settings: Settings;
  project: string;
  canRun: boolean;
  running: boolean;
  /** Finished / total tasks of the running thread, for the progress bar. */
  progress?: { done: number; total: number };
  placeholder: string;
  /** Text to place in the box (e.g. an example picked in the tutorial); n changes per pick. */
  draft?: { text: string; n: number };
  onSubmit: (prompt: string, mode: RunMode) => Promise<void>;
  onOpenSafety: () => void;
  onStop: () => void;
  onOpenCrew: () => void;
  onSettings: (patch: Partial<Settings>) => Promise<void>;
}

export function Composer(p: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<RunMode>("build");
  const [error, setError] = useState("");

  const submit = async () => {
    if (!prompt.trim() || p.running || !p.canRun) return;
    setSending(true);
    setError("");
    try {
      await p.onSubmit(prompt.trim(), mode);
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!p.draft) return;
    setPrompt(p.draft.text);
    box.current?.focus();
  }, [p.draft]);

  return (
    <div className="composer-wrap">
      <form
        className={`composer ${p.running ? "is-running" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {p.running && p.progress && p.progress.total > 0 && (
          <span
            className="composer-progress"
            aria-label={`${p.progress.done} of ${p.progress.total} tasks done`}
          >
            <span
              style={{
                width: `${(p.progress.done / p.progress.total) * 100}%`,
              }}
            />
          </span>
        )}
        <textarea
          ref={box}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={p.placeholder}
          disabled={!p.canRun}
          rows={2}
          maxLength={20000}
          aria-label="Message the crew"
        />
        <div className="composer-bar">
          <div
            className="seg mini mode-switch"
            role="radiogroup"
            aria-label="What the crew should do"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === "build"}
              className={mode === "build" ? "is-active" : ""}
              onClick={() => setMode("build")}
            >
              Build
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "design"}
              className={mode === "design" ? "is-active" : ""}
              onClick={() => setMode("design")}
              title="Several models each design their own version; you pick one"
            >
              <Icon name="palette" size={13} /> MultiDesign
            </button>
          </div>
          <TeamPicker
            team={p.team}
            crew={p.crew}
            connections={p.connections}
            onTeam={p.onTeam}
            onEditCrew={p.onOpenCrew}
            manager={p.manager}
          />
          <MoreControls
            settings={p.settings}
            onSettings={p.onSettings}
            onOpenSafety={p.onOpenSafety}
          />
          {p.running ? (
            <button
              type="button"
              className="send stop"
              onClick={p.onStop}
              aria-label="Stop the crew"
              title="Stop"
            >
              <Icon name="stop" size={13} />
            </button>
          ) : (
            <button
              className="send"
              disabled={!p.canRun || !prompt.trim() || sending}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="err-text composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SAFETY: { id: Settings["safety"]; label: string; hint: string }[] = [
  {
    id: "direct",
    label: "Direct + undo",
    hint: "Edits the project; one click undoes a run",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    hint: "Works on a copy; you apply the result",
  },
  {
    id: "readonly",
    label: "Plan only",
    hint: "Plans and explains; changes nothing",
  },
];

/** The composer's "…" menu (as in T3 Code): how the crew may work, kept out of the way. */
function MoreControls(p: {
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => Promise<void>;
  onOpenSafety: () => void;
}) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 160);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const s = p.settings;
  return (
    <div className="more-controls" ref={ref}>
      {presence.mounted && (
        <div
          className={`menu-pop more-pop ${presence.closing ? "is-closing" : ""}`}
          role="menu"
          inert={!open}
        >
          <div className="team-list-head">How the crew works</div>
          {SAFETY.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={s.safety === m.id}
              className={`menu-item more-item ${s.safety === m.id ? "is-active" : ""}`}
              onClick={() => void p.onSettings({ safety: m.id })}
            >
              <Icon name="shield" size={14} />
              <span className="more-text">
                <span>{m.label}</span>
                <span className="muted small">{m.hint}</span>
              </span>
              {s.safety === m.id && (
                <Icon name="check" size={14} className="team-check" />
              )}
            </button>
          ))}
          <div className="more-row">
            <span>Review rounds</span>
            <div
              className="seg mini"
              role="radiogroup"
              aria-label="Review rounds"
            >
              {[0, 1, 2, 3].map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={s.maxReviewRounds === n}
                  className={s.maxReviewRounds === n ? "is-active" : ""}
                  onClick={() => void p.onSettings({ maxReviewRounds: n })}
                >
                  {n === 0 ? "Off" : n}
                </button>
              ))}
            </div>
          </div>
          <div className="more-row">
            <span>
              Economy{" "}
              <span className="muted small">
                fewer tokens, free models first
              </span>
            </span>
            <button
              role="switch"
              aria-checked={s.economy}
              aria-label="Economy"
              className={`switch ${s.economy ? "on" : ""}`}
              onClick={() => void p.onSettings({ economy: !s.economy })}
            >
              <span />
            </button>
          </div>
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              p.onOpenSafety();
            }}
          >
            <Icon name="settings" size={14} /> All savings & safety settings
          </button>
        </div>
      )}
      <button
        type="button"
        className={`icon-btn more-btn ${open ? "is-on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label="More composer controls"
        aria-expanded={open}
        title={`${SAFETY.find((m) => m.id === s.safety)?.label ?? ""}${s.economy ? " · Economy" : ""} · Review ×${s.maxReviewRounds}`}
      >
        <Icon name="menu" size={16} />
        {(s.safety !== "direct" || s.economy) && <span className="more-dot" />}
      </button>
    </div>
  );
}
