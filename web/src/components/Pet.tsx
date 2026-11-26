import { useEffect, useRef, useState } from "react";
import type { RunSummary } from "../../../server/shared";
import { api } from "../api";
import { plainPrompt } from "./PromptText";
import { todosChanged, useTodos } from "./TodoList";
import { loadPrefs, PREFS_KEY, type PetKind, type Prefs } from "../prefs";

type Approval = Awaited<ReturnType<typeof api.approvals>>[number];
type Mood = "idle" | "thinking" | "busy" | "alert" | "happy" | "sad" | "sleep";

/** The pet's picture for a mood. The cat has a face per mood; the others show a small sign beside them. */
function petImage(kind: PetKind, mood: Mood): string {
  return kind === "cat" ? `/pets/cat-${mood === "sad" ? "angry" : mood}.png` : `/pets/${kind}.png`;
}
const MOOD_SIGN: Record<Mood, string> = { idle: "", thinking: "…", busy: "", alert: "!", happy: "✓", sad: "×", sleep: "z" };
/** After this long with nothing going on, the pet curls up and sleeps. */
const SLEEP_AFTER = 3 * 60_000;
/** A task this new is still being planned: the pet thinks before it types. */
const THINK_FOR = 25_000;

/** The chosen pet, kept in step with Preferences (in this window and in the pet's own window). */
function usePetKind(): PetKind {
  const [kind, setKind] = useState<PetKind>(() => loadPrefs().petKind);
  useEffect(() => {
    const onPrefs = (e: Event) => setKind((e as CustomEvent<Prefs>).detail.petKind);
    const onStorage = (e: StorageEvent) => e.key === PREFS_KEY && setKind(loadPrefs().petKind);
    window.addEventListener("multicode:prefs", onPrefs);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("multicode:prefs", onPrefs);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return kind;
}

/**
 * MultiCode's pet: a little character that sits on your screen (its own window in the desktop
 * app, a corner of the page in the browser). It asks for approvals, says when work is done or
 * failed, and when a new version is ready. Everything else, it naps.
 */
export function Pet({ onOpen, standalone = false }: { onOpen: (runId: string) => void; standalone?: boolean }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [update, setUpdate] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [hover, setHover] = useState(false);
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(Date.now());
  const kind = usePetKind();
  const [todos] = useTodos();
  const nextTodo = todos.find((t) => !t.done);
  const openTodos = todos.filter((t) => !t.done).length;
  const [cheer, setCheer] = useState(false);
  const tick = async (id: string) => {
    await api.updateTodo(id, { done: true }).catch(() => {});
    todosChanged();
    setCheer(true);
    window.setTimeout(() => setCheer(false), 1600);
  };

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const [a, r] = await Promise.all([api.approvals().catch(() => []), api.allRuns().catch(() => null)]);
      if (!live) return;
      setApprovals(a);
      if (r) setRuns(r);
      setNow(Date.now());
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  // A new version (desktop app): checked now and every half hour.
  useEffect(() => {
    const u = window.multicodeDesktop?.update;
    if (!u) return;
    const check = () => void u.check().then((r) => setUpdate(r?.available && r.version ? r.version : null)).catch(() => {});
    check();
    const t = window.setInterval(check, 30 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  const working = runs.filter((r) => r.status === "running");
  // Finished since the pet started, in the last 10 minutes, not yet waved away.
  const finished = runs
    .filter((r) => r.endedAt && r.endedAt > startedAt.current && now - r.endedAt < 10 * 60_000 && !dismissed.has(r.id) && r.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const ask = approvals[0];

  const dismiss = (id: string) => setDismissed((s) => new Set(s).add(id));
  const answer = async (a: Approval, allow: boolean) => {
    setBusy(a.id);
    await api.approve(a.runId, a.id, allow).catch(() => {});
    setApprovals((list) => list.filter((x) => x.id !== a.id));
    setBusy("");
  };

  let mood: Mood = "idle";
  let bubble: React.ReactNode = null;
  if (ask) {
    mood = "alert";
    bubble = (
      <>
        <span className="pet-kicker">Waiting for you · {ask.chat}</span>
        <span className="pet-text">{ask.title}</span>
        <span className="pet-actions">
          <button className="pet-btn primary" disabled={busy === ask.id} onClick={() => void answer(ask, true)}>
            Allow
          </button>
          <button className="pet-btn" disabled={busy === ask.id} onClick={() => void answer(ask, false)}>
            Decline
          </button>
          <button className="pet-btn ghost" onClick={() => onOpen(ask.runId)}>
            Open
          </button>
        </span>
        {approvals.length > 1 && <span className="pet-more">+{approvals.length - 1} more waiting</span>}
      </>
    );
  } else if (finished) {
    const ok = finished.status === "done";
    mood = ok ? "happy" : "sad";
    bubble = (
      <>
        <span className="pet-kicker">{ok ? (finished.pending ? "Ready for your review" : "Done") : finished.status === "cancelled" ? "Stopped" : "Something went wrong"}</span>
        <span className="pet-text">{finished.title || plainPrompt(finished.prompt)}</span>
        <span className="pet-actions">
          <button className="pet-btn primary" onClick={() => { onOpen(finished.id); dismiss(finished.id); }}>
            Open
          </button>
          <button className="pet-btn ghost" onClick={() => dismiss(finished.id)}>
            OK
          </button>
        </span>
      </>
    );
  } else if (update && !dismissed.has(`update-${update}`)) {
    mood = "happy";
    bubble = (
      <>
        <span className="pet-kicker">New version</span>
        <span className="pet-text">MultiCode {update} is ready. Update from the sidebar.</span>
        <span className="pet-actions">
          <button className="pet-btn ghost" onClick={() => dismiss(`update-${update}`)}>
            Later
          </button>
        </span>
      </>
    );
  } else if (working.length) {
    mood = Math.max(...working.map((r) => r.startedAt)) > now - THINK_FOR ? "thinking" : "busy";
    if (hover)
      bubble = (
        <>
          <span className="pet-kicker">Working{working.length > 1 ? ` on ${working.length} tasks` : ""}</span>
          <span className="pet-text">{working[0]!.title || plainPrompt(working[0]!.prompt)}</span>
        </>
      );
  } else if (cheer) {
    mood = "happy";
    bubble = <span className="pet-text">Nice, one less thing{openTodos ? ` · ${openTodos} to go` : ". All done!"}</span>;
  } else if (hover && nextTodo) {
    bubble = (
      <>
        <span className="pet-kicker">Next to-do{openTodos > 1 ? ` · ${openTodos} open` : ""}{nextTodo.project ? ` · ${nextTodo.project}` : ""}</span>
        <span className="pet-text">{nextTodo.text}</span>
        <span className="pet-actions">
          <button className="pet-btn primary" onClick={() => void tick(nextTodo.id)}>
            Done
          </button>
        </span>
      </>
    );
  } else if (hover) {
    bubble = <span className="pet-text">All quiet. Ctrl+K finds anything; / opens commands.</span>;
  }

  // Asleep after a quiet while; anything happening, or a hover, wakes it.
  const lastActive = useRef(Date.now());
  if (mood !== "idle" || hover || bubble) lastActive.current = now;
  if (mood === "idle" && !hover && now - lastActive.current > SLEEP_AFTER) mood = "sleep";

  return (
    <div className={`pet ${standalone ? "is-standalone" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {bubble && (
        <div className="pet-bubble" role="status" aria-live="polite">
          {bubble}
        </div>
      )}
      <div className={`pet-body is-${mood}`} title="MultiCode" aria-hidden>
        <img key={mood} className={`pet-img ${kind === "cat" ? "is-cat" : ""}`} src={petImage(kind, mood)} alt="" draggable={false} />
        {kind === "cat" ? (
          <>
            {mood === "thinking" && <span className="pet-think"><i /><i /><i /></span>}
            {mood === "alert" && <span className="pet-bang">!</span>}
            {mood === "sleep" && <span className="pet-zz"><b>z</b><b>z</b><b>Z</b></span>}
            {mood === "happy" && <span className="pet-sparks"><i /><i /><i /><i /></span>}
          </>
        ) : (
          MOOD_SIGN[mood] && <span className={`pet-sign is-${mood}`}>{MOOD_SIGN[mood]}</span>
        )}
        {mood === "busy" && kind !== "cat" && <span className="pet-dots"><i /><i /><i /></span>}
        {approvals.length > 0 && <span className="pet-badge">{approvals.length}</span>}
      </div>
    </div>
  );
}
