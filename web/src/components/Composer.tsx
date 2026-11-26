import { useEffect, useRef, useState } from "react";
import { loadPrefs } from "../prefs";
import { api } from "../api";
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
import { SuggestMenu, triggerAt, useSuggest, type SlashId, type Trigger } from "./ComposerSuggest";

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
  /** Sleep mode: the crew works alone; while it's busy, new work is queued. */
  sleep: boolean;
  onSleep: (on: boolean) => void;
  /** A "/" command the app handles (new thread, open a panel or a setting). */
  onCommand?: (id: SlashId) => void;
}

export function Composer(p: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<RunMode>("build");
  const [error, setError] = useState("");

  // Pictures pasted, dropped or picked: saved in the project and mentioned with @path.
  const [pics, setPics] = useState<{ path: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  const filePick = useRef<HTMLInputElement>(null);
  const addPictures = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, 4 - pics.length));
    for (const f of list) {
      setUploading((n) => n + 1);
      try {
        const { path } = await api.attach(p.project, f);
        setPics((x) => [...x, { path, url: api.attachmentUrl(p.project, path) }]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async () => {
    if ((!prompt.trim() && !pics.length) || !p.canRun || uploading) return;
    setSending(true);
    setError("");
    try {
      const text = [prompt.trim() || "Look at this picture.", pics.map((x) => `@${x.path}`).join(" ")]
        .filter(Boolean)
        .join("\n\n");
      await p.onSubmit(text, mode);
      setPrompt("");
      setPics([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const box = useRef<HTMLTextAreaElement>(null);
  // "/" commands and "@" file mentions.
  const [trigger, setTrigger] = useState<Trigger>(null);
  const [active, setActive] = useState(0);
  const { items, custom } = useSuggest(p.project, trigger);
  const track = (el: HTMLTextAreaElement) => {
    const t = triggerAt(el.value, el.selectionStart ?? el.value.length);
    setTrigger(t);
    setActive(0);
  };
  const runCommand = (id: SlashId) => {
    setPrompt("");
    setTrigger(null);
    const safety = { plan: "readonly", direct: "direct", sandbox: "sandbox" } as const;
    const approvals = { ask: "ask", "auto-edit": "edits", "approve-all": "all" } as const;
    if (id === "build" || id === "design") setMode(id);
    else if (id === "sleep") p.onSleep(!p.sleep);
    else if (id in safety) void p.onSettings({ safety: safety[id as keyof typeof safety] });
    else if (id in approvals) void p.onSettings({ approvals: approvals[id as keyof typeof approvals] });
    else p.onCommand?.(id);
  };
  const pick = (i: number) => {
    const it = items[i];
    if (!it || !trigger) return;
    if (trigger.kind === "slash" && it.key.startsWith("custom:")) {
      // Your own command: its text goes in the box; the caret lands where $ARGUMENTS was.
      const body = custom.find((c) => `custom:${c.name}` === it.key)?.body ?? "";
      const at = body.indexOf("$ARGUMENTS");
      setPrompt(body.replace(/\$ARGUMENTS/g, ""));
      setTrigger(null);
      requestAnimationFrame(() => {
        const el = box.current;
        const pos = at >= 0 ? at : body.length;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
      return;
    }
    if (trigger.kind === "slash") return runCommand(it.key as SlashId);
    const el = box.current;
    const caret = el?.selectionStart ?? prompt.length;
    const next = `${prompt.slice(0, trigger.start)}@${it.key} ${prompt.slice(caret)}`;
    setPrompt(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = trigger.start + it.key.length + 2;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  useEffect(() => {
    if (!p.draft) return;
    setPrompt(p.draft.text);
    box.current?.focus();
  }, [p.draft]);

  return (
    <div className="composer-wrap">
      <form
        className={`composer ${p.running ? "is-running" : ""}`}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
          if (!files.length || !p.canRun) return;
          e.preventDefault();
          void addPictures(files);
        }}
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
        {trigger && (
          <SuggestMenu
            items={items}
            active={Math.min(active, Math.max(0, items.length - 1))}
            onPick={pick}
            title={trigger.kind === "slash" ? "Commands" : "Mention a file"}
          />
        )}
        {(pics.length > 0 || uploading > 0) && (
          <div className="composer-pics">
            {pics.map((x) => (
              <span key={x.path} className="composer-pic pop-in">
                <img src={x.url} alt="Attached picture" />
                <button
                  type="button"
                  className="composer-pic-x"
                  aria-label="Remove picture"
                  onClick={() => setPics((all) => all.filter((y) => y.path !== x.path))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            {uploading > 0 && <span className="composer-pic is-loading" aria-label="Uploading" />}
          </div>
        )}
        <textarea
          ref={box}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            void addPictures(files);
          }}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            track(e.target);
          }}
          onClick={(e) => track(e.currentTarget)}
          onBlur={() => setTrigger(null)}
          onKeyDown={(e) => {
            if (items.length && trigger) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                pick(active);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setTrigger(null);
                return;
              }
            }
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            const mod = e.ctrlKey || e.metaKey;
            // Settings > General: Enter sends, or Ctrl/⌘+Enter sends (then Enter is a new line).
            if (loadPrefs().sendKey !== "mod" || mod) {
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
          <input
            ref={filePick}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addPictures(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-btn attach-btn"
            onClick={() => filePick.current?.click()}
            disabled={!p.canRun || pics.length >= 4}
            title="Attach a picture (or paste / drop one)"
            aria-label="Attach a picture"
          >
            <Icon name="paperclip" size={15} />
          </button>
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
              title="The crew plans, builds and reviews it together"
            >
              <Icon name="hammer" size={13} /> MultiBuild
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
          <button
            type="button"
            className={`chip sleep-chip ${p.sleep ? "is-on" : ""}`}
            aria-pressed={p.sleep}
            onClick={() => p.onSleep(!p.sleep)}
            title={
              p.sleep
                ? "Sleep mode is on: the crew works alone and approves its own actions. Click to turn off."
                : "Sleep mode: give the crew work and go. It decides alone, never asks, and keeps the computer awake."
            }
          >
            <Icon name="moon" size={14} />
            <span className="sleep-label">Sleep</span>
          </button>
          <MoreControls
            settings={p.settings}
            onSettings={p.onSettings}
            onOpenSafety={p.onOpenSafety}
          />
          {p.running && (
            <button
              className="send"
              disabled={!p.canRun || (!prompt.trim() && !pics.length) || sending || uploading > 0}
              aria-label="Queue"
              title="Queue: runs after the crew finishes (Enter)"
            >
              <Icon name="plus" size={16} />
            </button>
          )}
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
              disabled={!p.canRun || (!prompt.trim() && !pics.length) || sending || uploading > 0}
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

const APPROVALS: { id: Settings["approvals"]; label: string; hint: string }[] = [
  { id: "ask", label: "Ask every time", hint: "You approve each change and tool" },
  { id: "edits", label: "Auto-accept edits", hint: "Changes go through; tools still ask" },
  { id: "all", label: "Approve all", hint: "Nothing asks (reads never do)" },
];

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
          <div className="team-list-head">Approvals</div>
          {APPROVALS.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={(s.approvals ?? "ask") === m.id}
              className={`menu-item more-item ${(s.approvals ?? "ask") === m.id ? "is-active" : ""}`}
              onClick={() => void p.onSettings({ approvals: m.id })}
            >
              <Icon name={m.id === "ask" ? "eye" : m.id === "edits" ? "pencil" : "check"} size={14} />
              <span className="more-text">
                <span>{m.label}</span>
                <span className="muted small">{m.hint}</span>
              </span>
              {(s.approvals ?? "ask") === m.id && (
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
        className={`chip safety-chip ${open ? "is-open" : ""} ${s.safety !== "direct" ? "is-guarded" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={`How the crew works: ${SAFETY.find((m) => m.id === s.safety)?.label ?? ""}${s.economy ? ", Economy" : ""}, review rounds ${s.maxReviewRounds}`}
        aria-expanded={open}
        title="How the crew works: safety, review rounds, economy"
      >
        <Icon name="shield" size={14} />
        <span className="safety-label">{SAFETY.find((m) => m.id === s.safety)?.label}</span>
        {s.economy && <span className="free-tag">Eco</span>}
      </button>
    </div>
  );
}
