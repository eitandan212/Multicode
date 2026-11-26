import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Todo } from "../../../server/todos";
import { TodoList } from "./TodoList";
import { UpdateButton } from "./UpdateButton";
import { UsageMeter } from "./UsageMeter";
import type {
  ConnectionView,
  ProjectInfo,
  RunSummary,
} from "../../../server/shared";
import { Icon, Spinner } from "./Icon";
import { Lockup } from "./Logo";
import { plainPrompt } from "./PromptText";
import { api } from "../api";

interface Props {
  projects: ProjectInfo[];
  runs: RunSummary[];
  connections: ConnectionView[];
  project: string | null;
  runId: string | null;
  onSelectRun: (run: RunSummary) => void;
  onSelectProject: (name: string) => void;
  onNewThread: () => void;
  /** A new chat in this project. */
  onNewThreadIn: (project: string) => void;
  onNewProject: () => void;
  /** Chats were renamed, pinned, archived or deleted: reload the list. */
  onChatsChanged: () => void;
  onOpenSettings: (
    section: "connections" | "safety" | "extensions" | "crew" | "usage",
  ) => void;
  onCollapse: () => void;
  /** Send a to-do to the crew as a new chat. */
  onSendTodo: (todo: Todo) => void;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "now", "4m", "2h", "3d": the age of a thread, as T3 Code shows it. */
/** When a snoozed chat comes back: later today, tomorrow morning, after the weekend, next week. */
const at9 = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
};
const SNOOZES: [string, () => number][] = [
  ["1 hour", () => Date.now() + 3_600_000],
  ["3 hours", () => Date.now() + 3 * 3_600_000],
  ["Tomorrow", () => at9(1)],
  ["Next week", () => at9(((8 - new Date().getDay()) % 7) || 7)],
];

/** "in 2h", "tomorrow 09:00", "Mon 09:00". */
function until(at: number, now: number): string {
  const ms = at - now;
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 12 * 3_600_000) return `in ${Math.round(ms / 3_600_000)}h`;
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return d.toDateString() === tomorrow.toDateString() ? `tomorrow ${time}` : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

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
/** Project name → its emoji, provided once by the app for every badge. */
export const ProjectEmojis = createContext<Record<string, string>>({});

export function ProjectBadge({
  name,
  size = 18,
}: {
  name: string;
  size?: number;
}) {
  const emoji = useContext(ProjectEmojis)[name];
  if (emoji)
    return (
      <span
        className="project-badge is-emoji"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.8) }}
        aria-hidden
      >
        {emoji}
      </span>
    );
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
const COLLAPSED_KEY = "multicode:collapsed-projects";
const readSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

interface Chat {
  key: string;
  first: RunSummary;
  latest: RunSummary;
  turns: number;
  title: string;
}

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  // A preview card beside a chat after a short hover (as T3 Code's thread hover card).
  const [peek, setPeek] = useState<{ chat: Chat; top: number; left: number } | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const startPeek = (chat: Chat, el: HTMLElement) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setPeek({ chat, top: Math.min(r.top, window.innerHeight - 220), left: r.right + 10 });
    }, 550);
  };
  const endPeek = () => {
    window.clearTimeout(peekTimer.current);
    setPeek(null);
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readSet(COLLAPSED_KEY));
  const [more, setMore] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const now = useNow(p.runs.some((r) => r.status === "running") ? 1000 : 30_000);
  const q = query.trim().toLowerCase();

  // Chats used to be "settled" in this browser only; they move to the server's Archive once.
  useEffect(() => {
    const old = readSet(SETTLED_KEY);
    if (!old.size) return;
    void Promise.all([...old].map((id) => api.updateChat(id, { archived: true }).catch(() => {}))).then(() => {
      try {
        localStorage.removeItem(SETTLED_KEY);
      } catch {
        /* fine */
      }
      p.onChatsChanged();
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);

  // Close an open chat menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest?.(".sb-menu, .sb-more")) {
        setMenu(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  // One row per chat: its first message (or your title), its newest turn, how many turns.
  const chats = useMemo(() => {
    const byKey = new Map<string, Chat>();
    for (const r of p.runs) {
      const key = r.threadId ?? r.id;
      const c = byKey.get(key);
      if (!c) byKey.set(key, { key, first: r, latest: r, turns: 1, title: "" });
      else {
        c.turns++;
        if (r.startedAt > c.latest.startedAt) c.latest = r;
        if (r.startedAt < c.first.startedAt) c.first = r;
      }
    }
    for (const c of byKey.values()) c.title = c.first.title || plainPrompt(c.first.prompt);
    return [...byKey.values()].sort((a, b) => b.latest.startedAt - a.latest.startedAt);
  }, [p.runs]);

  const matches = (c: Chat) => !q || c.title.toLowerCase().includes(q) || c.latest.prompt.toLowerCase().includes(q) || c.first.project.toLowerCase().includes(q);
  // A chat that works or waits for you never hides in the archive.
  const busy = (c: Chat) => c.latest.status === "running" || Boolean(c.latest.pending);
  // Snoozed chats wait in their own group until their time comes (or they need you).
  const snoozed = (c: Chat) => Boolean(c.first.snoozedUntil && c.first.snoozedUntil > now) && !busy(c);
  const visible = chats.filter((c) => matches(c) && (!c.first.archived || busy(c)) && !snoozed(c));
  const archived = chats.filter((c) => matches(c) && c.first.archived && !busy(c));
  const sleeping = chats.filter((c) => matches(c) && !c.first.archived && snoozed(c)).sort((a, b) => a.first.snoozedUntil! - b.first.snoozedUntil!);

  // Projects, the most recently active first; each with its own chats (pinned on top).
  const groups = useMemo(() => {
    const names = [...new Set([...visible.map((c) => c.first.project), ...p.projects.map((pr) => pr.name)])];
    return names
      .filter((n) => !q || visible.some((c) => c.first.project === n) || n.toLowerCase().includes(q))
      .map((name) => ({
        name,
        chats: visible
          .filter((c) => c.first.project === name)
          .sort((a, b) => Number(Boolean(b.first.pinned)) - Number(Boolean(a.first.pinned)) || b.latest.startedAt - a.latest.startedAt),
      }))
      .sort((a, b) => (b.chats[0]?.latest.startedAt ?? 0) - (a.chats[0]?.latest.startedAt ?? 0));
  }, [visible, p.projects, q]);

  const toggleCollapsed = (name: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n]));
      } catch {
        /* fine */
      }
      return n;
    });

  const update = async (c: Chat, patch: { title?: string | null; pinned?: boolean; archived?: boolean; snoozedUntil?: number | null }) => {
    setMenu(null);
    await api.updateChat(c.first.id, patch).catch(() => {});
    p.onChatsChanged();
  };
  const remove = async (c: Chat) => {
    setMenu(null);
    setConfirmDelete(null);
    await api.deleteChat(c.first.id).catch(() => {});
    if (c.latest.id === p.runId || c.first.id === p.runId) p.onNewThread();
    p.onChatsChanged();
  };

  const status = (r: RunSummary) =>
    r.status === "running" ? (
      <Spinner size={11} />
    ) : r.pending ? (
      <span className="sb-dot is-attention" title="Waiting for you" />
    ) : r.status === "error" ? (
      <span className="sb-dot is-bad" title="Failed" />
    ) : null;

  const row = (c: Chat) => {
    const active = p.runId !== null && [c.latest.id, c.first.id].includes(p.runId);
    const r = c.latest;
    return (
      <div key={c.key} className={`sb-row ${active ? "is-active" : ""} ${menu === c.key ? "has-menu" : ""}`}>
        {renaming?.key === c.key ? (
          <form
            className="sb-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void update(c, { title: renaming.value.trim() || null });
              setRenaming(null);
            }}
          >
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ key: c.key, value: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
              aria-label="Chat name"
              maxLength={120}
            />
          </form>
        ) : (
          <button
            className="sb-row-main"
            onClick={() => {
              endPeek();
              p.onSelectRun(r);
            }}
            onMouseEnter={(e) => menu === null && startPeek(c, e.currentTarget)}
            onMouseLeave={endPeek}
            onFocus={endPeek}
          >
            {c.first.pinned && <Icon name="pin" size={11} className="sb-pin" />}
            <span className="truncate">{c.title}</span>
            {c.turns > 1 && <span className="sb-turns">{c.turns}</span>}
            <span className="sb-row-end">
              {status(r) ?? <span className="sb-age">{r.status === "running" ? elapsed(now - r.startedAt) : ago(r.endedAt ?? r.startedAt, now)}</span>}
            </span>
          </button>
        )}
        <button
          className="sb-more"
          aria-label={`Options for ${c.title}`}
          aria-expanded={menu === c.key}
          onClick={() => {
            setMenu(menu === c.key ? null : c.key);
            setConfirmDelete(null);
          }}
        >
          <Icon name="dots" size={14} />
        </button>
        {menu === c.key && (
          <div className="sb-menu menu-pop" role="menu">
            <button role="menuitem" onClick={() => { setMenu(null); setRenaming({ key: c.key, value: c.title }); }}>
              <Icon name="pencil" size={13} /> Rename
            </button>
            <button role="menuitem" onClick={() => void update(c, { pinned: !c.first.pinned })}>
              <Icon name="pin" size={13} /> {c.first.pinned ? "Unpin" : "Pin to top"}
            </button>
            {snoozed(c) ? (
              <button role="menuitem" onClick={() => void update(c, { snoozedUntil: null })}>
                <Icon name="bell" size={13} /> Wake up now
              </button>
            ) : (
              <div className="sb-snooze" role="group" aria-label="Snooze">
                <span><Icon name="moon" size={13} /> Snooze</span>
                {SNOOZES.map(([label, at]) => (
                  <button key={label} role="menuitem" disabled={busy(c)} onClick={() => void update(c, { snoozedUntil: at() })}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <button role="menuitem" onClick={() => void update(c, { archived: !c.first.archived })} disabled={busy(c)}>
              <Icon name="archive" size={13} /> {c.first.archived ? "Move out of archive" : "Archive (hide)"}
            </button>
            {confirmDelete === c.key ? (
              <button role="menuitem" className="is-danger" onClick={() => void remove(c)} disabled={r.status === "running"}>
                <Icon name="trash" size={13} /> Delete for good?
              </button>
            ) : (
              <button role="menuitem" className="is-danger" onClick={() => setConfirmDelete(c.key)} disabled={r.status === "running"}>
                <Icon name="trash" size={13} /> Delete
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav className="sidebar" aria-label="Chats">
      <div className="sb-head">
        <button className="icon-btn" onClick={p.onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)">
          <Icon name="sidebar" />
        </button>
        <Lockup size={20} />
      </div>

      <div className="sb-search">
        <label className="search-field">
          <Icon name="search" />
          <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
        </label>
        <button className="icon-btn" onClick={p.onNewProject} title="New project" aria-label="New project">
          <Icon name="folderPlus" />
        </button>
      </div>

      <div className="sb-list">
        {groups.map((g) => {
          const open = !collapsed.has(g.name) || Boolean(q);
          const shown = more.has(g.name) || q ? g.chats : g.chats.slice(0, 6);
          return (
            <section key={g.name} className={`sb-project ${g.name === p.project ? "is-current" : ""}`}>
              <div className="sb-project-head">
                <button className="sb-project-name" onClick={() => toggleCollapsed(g.name)} aria-expanded={open} title={open ? "Fold" : "Unfold"}>
                  <Icon name={open ? "chevronDown" : "chevron"} size={12} className="sb-caret" />
                  <ProjectBadge name={g.name} size={16} />
                  <span className="truncate">{g.name}</span>
                </button>
                <button className="icon-btn sb-new-chat" onClick={() => p.onNewThreadIn(g.name)} title={`New chat in ${g.name}`} aria-label={`New chat in ${g.name}`}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
              {open && (
                <div className="sb-chats">
                  {g.chats.length === 0 && (
                    <button className="sb-empty-row" onClick={() => p.onNewThreadIn(g.name)}>
                      Start the first chat
                    </button>
                  )}
                  {shown.map(row)}
                  {g.chats.length > shown.length && (
                    <button className="sb-show-more" onClick={() => setMore((s) => new Set(s).add(g.name))}>
                      Show {g.chats.length - shown.length} more
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {groups.length === 0 && <p className="sb-empty">{q ? "No matches" : "No chats yet"}</p>}
      </div>

      {sleeping.length > 0 && (
        <div className="sb-groups">
          <button className="sb-group" onClick={() => setShowSnoozed(!showSnoozed)} aria-expanded={showSnoozed}>
            <Icon name="moon" size={13} />
            <span>Snoozed</span>
            <span className="sb-count">{sleeping.length}</span>
            <Icon name={showSnoozed ? "chevronDown" : "chevron"} size={14} />
          </button>
          {showSnoozed && (
            <div className="sb-settled">
              {sleeping.map((c) => (
                <div key={c.key} className="sb-snoozed-row">
                  {row(c)}
                  <span className="sb-wake">back {until(c.first.snoozedUntil!, now)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {archived.length > 0 && (
        <div className="sb-groups">
          <button className="sb-group" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            <Icon name="archive" size={13} />
            <span>Archive</span>
            <span className="sb-count">{archived.length}</span>
            <Icon name={showArchived ? "chevronDown" : "chevron"} size={14} />
          </button>
          {showArchived && <div className="sb-settled">{archived.map(row)}</div>}
        </div>
      )}

      {peek && createPortal(<ChatPeek chat={peek.chat} top={peek.top} left={peek.left} now={now} />, document.body)}
      <TodoList project={p.project} onSend={p.onSendTodo} />
      <UsageMeter onOpen={() => p.onOpenSettings("usage")} />
      <UpdateButton />
      <div className="sb-foot">
        <button
          className="sb-settings"
          onClick={() => p.onOpenSettings("connections")}
          title="Settings (models, connections, appearance)"
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}

/** The hover card: what was asked, how it ended, which files changed. */
function ChatPeek({ chat, top, left, now }: { chat: Chat; top: number; left: number; now: number }) {
  const r = chat.latest;
  const state =
    r.status === "running" ? "Working…" : r.pending ? "Waiting for your review" : r.status === "error" ? "Failed" : r.status === "cancelled" ? "Stopped" : "Done";
  return (
    <div className="sb-peek" style={{ top, left }} role="tooltip">
      <div className="sb-peek-head">
        <strong className="truncate">{chat.title}</strong>
        <span className={`sb-peek-state is-${r.status}${r.pending ? " is-pending" : ""}`}>{state}</span>
      </div>
      <p className="sb-peek-ask">{plainPrompt(r.prompt).slice(0, 220)}</p>
      {r.reply && <p className="sb-peek-reply">{r.reply.slice(0, 260)}</p>}
      <div className="sb-peek-foot">
        <span>{chat.first.project}</span>
        {chat.turns > 1 && <span>{chat.turns} messages</span>}
        {r.changedFiles?.length ? <span>{r.changedFiles.length} file{r.changedFiles.length === 1 ? "" : "s"} changed</span> : null}
        <span>{ago(r.endedAt ?? r.startedAt, now)}</span>
      </div>
    </div>
  );
}
