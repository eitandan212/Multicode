// Settings sections T3 Code has and MultiCode was missing: General, Keyboard shortcuts, Projects, About.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectInfo } from "../../../server/shared";
import { api } from "../api";
import { chime, DEFAULT_PREFS, loadPrefs, notify, savePrefs, type Prefs } from "../prefs";
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
      <Row label="Sound">
        <Toggle checked={p.sound} onChange={(v) => { set({ sound: v }); if (v) chime(); }} text="A soft chime when a thread finishes" />
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
  ["New thread", [MOD, "Shift", "O"]],
  ["Show or hide the sidebar", [MOD, "B"]],
  ["Show or hide the side panel", [MOD, "J"]],
  ["Switch Chat / IDE view", [MOD, "E"]],
  ["Focus the message box", ["/"]],
  ["Send", ["Enter"]],
  ["New line", ["Shift", "Enter"]],
  ["Close a dialog or menu", ["Esc"]],
];

export function KeybindingsDialog({ onClose }: { onClose: () => void }) {
  const send = loadPrefs().sendKey;
  return (
    <Shell title="Keyboard shortcuts" sub="Everything you can do without the mouse." onClose={onClose}>
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
