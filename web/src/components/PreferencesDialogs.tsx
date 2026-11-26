// Settings sections T3 Code has and MultiCode was missing: General, Keyboard shortcuts, Projects, About.
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Hook, HookEvent, ProjectInfo, Settings } from "../../../server/shared";
import { api, type AccountUser } from "../api";
import { CurrentUser } from "./AuthGate";
import { signInWithGoogle } from "./SignIn";
import { chime, DEFAULT_PREFS, loadPrefs, notify, PET_KINDS, savePrefs, type Prefs } from "../prefs";
import { Row, Seg, Toggle } from "./AppearanceDialog";
import { useOpenDialog } from "./embed";
import { Icon, Spinner } from "./Icon";
import { ProjectBadge } from "./Sidebar";

function Shell(p: { title: string; sub: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  useEffect(() => {
    openDialog(ref.current);
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${p.className ?? ""}`} onClose={p.onClose} onCancel={p.onClose}>
      <header className="dialog-head">
        <div>
          <h2>{p.title}</h2>
          <p className="muted">{p.sub}</p>
        </div>
        <button className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="dialog-body appearance prefs">{p.children}</div>
    </dialog>
  );
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

export function GeneralDialog({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<Prefs>(loadPrefs);
  const [perm, setPerm] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const set = (patch: Partial<Prefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    savePrefs(next);
  };
  const askPermission = async () => {
    if (typeof Notification === "undefined") return;
    setPerm(await Notification.requestPermission());
  };
  return (
    <Shell title="General" sub="How MultiCode behaves on this computer." onClose={onClose}>
      <Row label="Send with">
        <Seg<Prefs["sendKey"]>
          value={p.sendKey}
          options={[
            ["enter", "Enter"],
            ["mod", `${MOD} + Enter`],
          ]}
          onChange={(v) => set({ sendKey: v })}
        />
        <p className="muted small">
          {p.sendKey === "enter" ? "Shift + Enter starts a new line." : "Enter starts a new line, handy for long prompts."}
        </p>
      </Row>
      <Row label="Notifications">
        <Toggle checked={p.notifyDone} onChange={(v) => set({ notifyDone: v })} text="When a thread finishes or fails" />
        <Toggle
          checked={p.notifyApproval}
          onChange={(v) => set({ notifyApproval: v })}
          text="When the crew waits for your approval"
        />
        <p className="muted small">Only while MultiCode isn't the window in front.</p>
        {perm === "default" && (p.notifyDone || p.notifyApproval) && (
          <button className="btn small" onClick={() => void askPermission()}>
            <Icon name="bell" size={14} /> Allow notifications
          </button>
        )}
        {perm === "denied" && <p className="err-text small">Notifications are blocked for MultiCode in your system settings.</p>}
        {perm === "granted" && (
          <button className="btn small ghost" onClick={() => notify("MultiCode", "Notifications work 🎉")}>
            Send a test
          </button>
        )}
      </Row>
      <Row label="Pet">
        <Toggle
          checked={p.pet}
          onChange={(v) => set({ pet: v })}
          text={window.multicodeDesktop?.setPet ? "A little helper on your screen: approvals, finished work, to-dos, news" : "A little helper in the corner: approvals, finished work, to-dos, news"}
        />
        {p.pet && (
          <div className="pet-picker" role="radiogroup" aria-label="Choose your pet">
            {PET_KINDS.map((k) => (
              <button key={k.id} role="radio" aria-checked={p.petKind === k.id} className={`pet-choice ${p.petKind === k.id ? "is-on" : ""}`} onClick={() => set({ petKind: k.id })}>
                <img src={k.id === "cat" ? "/pets/cat-idle.png" : `/pets/${k.id}.png`} alt="" />
                {k.label}
              </button>
            ))}
          </div>
        )}
      </Row>
      <Row label="Sound">
        <Toggle checked={p.sound} onChange={(v) => { set({ sound: v }); if (v) chime(); }} text="A soft chime when a thread finishes" />
      </Row>
      <Row label="Shortcuts">
        <ShortcutList />
      </Row>
      <div className="form-actions">
        <button className="btn ghost" onClick={() => { setP(DEFAULT_PREFS); savePrefs(DEFAULT_PREFS); }}>
          Reset
        </button>
      </div>
    </Shell>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ["Command palette", [MOD, "K"]],
  ["New chat", [MOD, "Shift", "O"]],
  ["New project", [MOD, "Shift", "N"]],
  ["Previous / next chat", ["Alt", "↑ ↓"]],
  ["Switch project (most recent first)", [MOD, "1…9"]],
  ["Focus the message box", [MOD, "L"]],
  ["Commands in the message box", ["/"]],
  ["Send", ["Enter"]],
  ["New line", ["Shift", "Enter"]],
  ["Stop the crew", [MOD, "."]],
  ["Archive this chat", [MOD, "Shift", "A"]],
  ["Show or hide the sidebar", [MOD, "B"]],
  ["Show or hide the side panel", [MOD, "J"]],
  ["Switch Chat / IDE view", [MOD, "E"]],
  ["Light / dark", [MOD, "Shift", "L"]],
  ["Settings", [MOD, ","]],
  ["These shortcuts", ["?"]],
  ["Close a dialog or menu", ["Esc"]],
];

function ShortcutList() {
  const send = loadPrefs().sendKey;
  return (
      <ul className="kb-list">
        {SHORTCUTS.map(([label, keys], i) => {
          const k =
            send === "mod" && label === "Send" ? [MOD, "Enter"] : send === "mod" && label === "New line" ? ["Enter"] : keys;
          return (
            <li key={label} style={{ ["--i" as string]: i }}>
              <span>{label}</span>
              <span className="kb-keys">
                {k.map((x) => (
                  <kbd key={x}>{x}</kbd>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
  );
}

export function KeybindingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Shell title="Keyboard shortcuts" sub="Everything you can do without the mouse." onClose={onClose}>
      <ShortcutList />
    </Shell>
  );
}

export function ProjectsDialog({
  projects,
  projectsDir,
  onClose,
  onChanged,
  onOpen,
}: {
  projects: ProjectInfo[];
  projectsDir: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpen: (name: string) => void;
}) {
  const reveal = window.multicodeDesktop?.openPath;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const where = (pr: ProjectInfo) => pr.path ?? (projectsDir ? `${projectsDir}/${pr.name}` : "");
  const unlink = async (name: string) => {
    setBusy(name);
    setError("");
    try {
      await api.unlinkProject(name);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Shell title="Projects" sub="Every project MultiCode knows about." onClose={onClose}>
      {error && <p className="err-text">{error}</p>}
      {projects.length === 0 ? (
        <p className="muted">No projects yet. Create one or open a folder from the sidebar.</p>
      ) : (
        <ul className="proj-list">
          {[...projects].sort((a, b) => b.updatedAt - a.updatedAt).map((pr, i) => (
            <li key={pr.name} style={{ ["--i" as string]: i }}>
              <ProjectBadge name={pr.name} size={28} />
              <span className="proj-info">
                <strong className="truncate">{pr.name}</strong>
                <span className="muted small truncate" title={where(pr)}>
                  {pr.path ? "Folder on this computer · " : ""}
                  {pr.fileCount} file{pr.fileCount === 1 ? "" : "s"}
                  {where(pr) ? ` · ${where(pr)}` : ""}
                </span>
              </span>
              <form
                className="proj-check"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (new FormData(e.currentTarget).get("check") as string) ?? "";
                  setBusy(`check:${pr.name}`);
                  setError("");
                  api
                    .setProjectCheck(pr.name, v)
                    .then(onChanged, (err: Error) => setError(err.message))
                    .finally(() => setBusy(""));
                }}
              >
                <input
                  name="check"
                  defaultValue={pr.check ?? ""}
                  placeholder="Check after each build, e.g. npm test"
                  aria-label={`Check command for ${pr.name}`}
                  maxLength={500}
                  spellCheck={false}
                />
                <button className="btn small" disabled={busy === `check:${pr.name}`}>
                  {busy === `check:${pr.name}` ? <Spinner /> : "Save"}
                </button>
              </form>
              <span className="proj-actions">
                <button className="btn small" onClick={() => onOpen(pr.name)}>Open</button>
                {reveal && where(pr) && (
                  <button className="icon-btn" title="Show in folder" aria-label="Show in folder" onClick={() => void reveal(where(pr))}>
                    <Icon name="folder" size={15} />
                  </button>
                )}
                {pr.path && (
                  <button
                    className="icon-btn"
                    title="Remove from the list (the folder stays on your computer)"
                    aria-label="Remove from list"
                    disabled={busy === pr.name}
                    onClick={() => void unlink(pr.name)}
                  >
                    {busy === pr.name ? <Spinner /> : <Icon name="x" size={15} />}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

type About = Awaited<ReturnType<typeof api.about>>;

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [about, setAbout] = useState<About | null>(null);
  const [update, setUpdate] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const desktop = window.multicodeDesktop;
  useEffect(() => {
    void api.about().then(setAbout).catch(() => {});
  }, []);
  const check = async () => {
    if (!desktop?.update) return;
    setChecking(true);
    try {
      const r = await desktop.update.check();
      setUpdate(
        !r ? "Couldn't check right now." : r.error ? `Couldn't check: ${r.error}` : r.available
          ? `Version ${r.version} is ready. Use the Update button in the sidebar.`
          : "You're on the latest version ✨",
      );
    } finally {
      setChecking(false);
    }
  };
  return (
    <Shell title="About" sub="Version, updates and where your data lives." onClose={onClose} className="about-dialog">
      <div className="about-hero">
        <span className="about-logo" aria-hidden>
          <Icon name="hammer" size={26} />
        </span>
        <div>
          <strong>MultiCode</strong>
          <span className="muted small">Version {about?.version ?? "…"}</span>
        </div>
      </div>
      {desktop?.update && (
        <Row label="Updates">
          <button className="btn small" onClick={() => void check()} disabled={checking}>
            {checking ? <Spinner /> : <Icon name="sync" size={14} />} Check for updates
          </button>
          {update && <p className="muted small pop-in">{update}</p>}
        </Row>
      )}
      <Row label="Data">
        <code className="about-path">{about?.dataDir ?? "…"}</code>
        {desktop?.openPath && about?.dataDir && (
          <span className="about-actions">
            <button className="btn small" onClick={() => void desktop.openPath!(about.dataDir!)}>
              <Icon name="folder" size={14} /> Open data folder
            </button>
            {about.errorLog && (
              <button className="btn small" onClick={() => void desktop.openPath!(about.errorLog!)}>
                <Icon name="file" size={14} /> Show error log
              </button>
            )}
          </span>
        )}
      </Row>
      <Row label="System">
        <span className="muted small">
          {about ? `Node ${about.node} · ${about.platform}` : "…"}
        </span>
      </Row>
      <Row label="Source">
        <a className="link" href="https://github.com/eitandan212/Multicode" target="_blank" rel="noreferrer">
          github.com/eitandan212/Multicode <Icon name="external" size={12} />
        </a>
        <p className="muted small">Builds on open-source work from T3 Code (MIT) and the Claude Agent SDK.</p>
      </Row>
    </Shell>
  );
}

const HOOK_HELP: Record<HookEvent, string> = {
  UserPromptSubmit: "Before a request starts. Exit code 2 stops it; what it prints is added for the crew.",
  PostToolUse: "After the crew changes a file (e.g. a formatter). Matcher: a glob like **/*.ts.",
  Notification: "When an action waits for your approval.",
  Stop: "When a run ends (done, failed or stopped).",
};

/** Hooks, as in Claude Code: your commands on events, with the event as JSON on stdin. */
export function HooksDialog({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: () => void }) {
  const [hooks, setHooks] = useState<Hook[]>(settings.hooks ?? []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (i: number, patch: Partial<Hook>) => setHooks(hooks.map((h, k) => (k === i ? { ...h, ...patch } : h)));
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.saveSettings({ hooks: hooks.filter((h) => h.command.trim()) });
      setNote({ ok: true, text: "Saved." });
      onSaved();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Hooks" sub="Your commands run on events, like Claude Code hooks. They get the event as JSON on stdin." onClose={onClose}>
      {hooks.length === 0 && <p className="muted">No hooks yet. Run a formatter after edits, block risky requests, or ping yourself when a run ends.</p>}
      <ul className="hook-list">
        {hooks.map((h, i) => (
          <li key={i} className="pop-in">
            <div className="hook-row">
              <select value={h.event} onChange={(e) => set(i, { event: e.target.value as HookEvent })} aria-label="Event">
                {(Object.keys(HOOK_HELP) as HookEvent[]).map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
              {h.event === "PostToolUse" && (
                <input className="hook-matcher" value={h.matcher ?? ""} onChange={(e) => set(i, { matcher: e.target.value || undefined })} placeholder="**/*" aria-label="Files" spellCheck={false} />
              )}
              <button className="icon-btn" aria-label="Remove hook" onClick={() => setHooks(hooks.filter((_, k) => k !== i))}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <input
              className="hook-command"
              value={h.command}
              onChange={(e) => set(i, { command: e.target.value })}
              placeholder={h.event === "PostToolUse" ? "npx prettier --write ." : "your command"}
              aria-label="Command"
              spellCheck={false}
              maxLength={1000}
            />
            <span className="muted small">{HOOK_HELP[h.event]}</span>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button className="btn ghost" disabled={hooks.length >= 20} onClick={() => setHooks([...hooks, { event: "PostToolUse", command: "" }])}>
          <Icon name="plus" size={14} /> Add hook
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : null} Save
        </button>
      </div>
      {note && <p className={`small ${note.ok ? "muted pop-in" : "err-text"}`}>{note.text}</p>}
      <p className="muted small">Hooks run on this computer with your permissions, in the project folder. Only add commands you trust.</p>
    </Shell>
  );
}

/** Account: you, your password, signing out; for the owner, people and Google sign-in. */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { user, refresh } = useContext(CurrentUser);
  const [people, setPeople] = useState<AccountUser[]>([]);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [add, setAdd] = useState({ name: "", email: "", password: "" });
  const [google, setGoogle] = useState({ clientId: "", clientSecret: "" });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const owner = user?.role === "owner";
  const load = () => void api.authUsers().then(setPeople).catch(() => {});
  useEffect(load, []);
  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: ok });
      load();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  if (!user)
    return (
      <Shell title="Account" sub="Protect MultiCode with an account." onClose={onClose}>
        <p className="muted">There's no account yet. Create one and MultiCode asks for it from then on.</p>
        <div className="form-actions">
          <button className="btn primary" onClick={() => window.dispatchEvent(new Event("multicode:signin"))}>
            Create account
          </button>
        </div>
      </Shell>
    );

  return (
    <Shell title="Account" sub="Who you are, and who else may use MultiCode." onClose={onClose}>
      <Row label="You">
        <span>
          <strong>{user.name}</strong> <span className="muted small">{user.email} · {owner ? "owner" : "member"}</span>
        </span>
        <button className="btn small" onClick={() => void api.authLogout().then(refresh)}>
          Sign out
        </button>
      </Row>
      <Row label="Password">
        <form
          className="acct-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act("pw", () => api.authPassword(pw.current, pw.next), "Password changed. Other devices sign in again.").then(() => setPw({ current: "", next: "" }));
          }}
        >
          {user.hasPassword && (
            <input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
          )}
          <input type="password" placeholder="New password (8+ characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={8} />
          <button className="btn small" disabled={!pw.next || busy !== ""}>
            {busy === "pw" ? <Spinner /> : null} {user.hasPassword ? "Change" : "Set"} password
          </button>
        </form>
      </Row>
      {owner && (
        <Row label="People">
          <ul className="acct-people">
            {people.map((p) => (
              <li key={p.id}>
                <span className="truncate">
                  <strong>{p.name}</strong> <span className="muted small">{p.email}{p.google ? " · Google" : ""} · {p.role}</span>
                </span>
                {p.id !== user.id && (
                  <button className="icon-btn" aria-label={`Remove ${p.name}`} title="Remove" onClick={() => void act("rm", () => api.authRemoveUser(p.id), `Removed ${p.name}.`)}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form
            className="acct-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act("add", () => api.authAddUser({ name: add.name, email: add.email, ...(add.password ? { password: add.password } : {}) }), `Added ${add.email}.`).then(() => setAdd({ name: "", email: "", password: "" }));
            }}
          >
            <input placeholder="Name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
            <input type="email" placeholder="Email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} required />
            <input type="password" placeholder="Password (empty: Google only)" value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} autoComplete="new-password" />
            <button className="btn small" disabled={!add.email || busy !== ""}>
              <Icon name="plus" size={13} /> Add person
            </button>
          </form>
        </Row>
      )}
      {owner && (
        <Row label="Google sign-in">
          <p className="muted small">
            Create an OAuth client of type "Desktop app" in Google Cloud Console (APIs & Services, Credentials), then paste
            its ID and secret here. People you add can then sign in with their Google account.
          </p>
          <form
            className="acct-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act("google", () => api.authGoogle(google.clientId, google.clientSecret || undefined), google.clientId ? "Google sign-in is on." : "Google sign-in is off.");
            }}
          >
            <input placeholder="Client ID (…apps.googleusercontent.com)" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} spellCheck={false} />
            <input type="password" placeholder="Client secret" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} autoComplete="off" />
            <button className="btn small" disabled={busy !== ""}>
              Save
            </button>
          </form>
          {!user.google && (
            <button className="btn small" onClick={() => void act("link", () => signInWithGoogle(), "Your Google account is linked.")}>
              Link my Google account
            </button>
          )}
        </Row>
      )}
      {note && <p className={`small ${note.ok ? "muted pop-in" : "err-text"}`}>{note.text}</p>}
      <p className="muted small">Your API keys and secrets are stored encrypted on this computer.</p>
    </Shell>
  );
}
