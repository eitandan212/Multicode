import { useEffect, useRef, useState } from "react";
import { useOpenDialog } from "./embed";
import { EmojiPicker } from "./EmojiPicker";
import { Icon } from "./Icon";

/** New project: start an empty one, or open a folder that already exists on this computer. */
export function ProjectDialog(p: {
  onCreate: (name: string, emoji?: string) => Promise<void>;
  onOpenFolder: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  useEffect(() => {
    openDialog(ref.current);
  }, []);
  const [tab, setTab] = useState<"new" | "open">("new");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | undefined>();
  const [picking, setPicking] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop = Boolean(window.multicodeDesktop?.pickFolder);
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      ref.current?.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog project-dialog" onClose={p.onClose} onCancel={p.onClose}>
      <header className="dialog-head">
        <div>
          <h2>Project</h2>
          <p className="muted">Start something new, or work on a folder you already have.</p>
        </div>
        <button className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="dialog-body">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "new"} className={tab === "new" ? "is-active" : ""} onClick={() => setTab("new")}>
            <Icon name="folderPlus" size={14} /> New project
          </button>
          <button role="tab" aria-selected={tab === "open"} className={tab === "open" ? "is-active" : ""} onClick={() => setTab("open")}>
            <Icon name="folder" size={14} /> Open folder
          </button>
        </div>

        {tab === "new" ? (
          <form
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (clean) void act(() => p.onCreate(clean, emoji));
            }}
          >
            <label>
              Name
              <div className="row-input">
                <button
                  type="button"
                  className="emoji-choose"
                  onClick={() => setPicking(!picking)}
                  title="Choose an emoji"
                  aria-label={emoji ? `Emoji ${emoji}, change` : "Choose an emoji"}
                >
                  {emoji ?? <Icon name="smile" size={16} />}
                </button>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. coffee-shop" maxLength={48} autoFocus />
              </div>
            </label>
            {picking && (
              <EmojiPicker value={emoji} onPick={(e) => setEmoji(e ?? undefined)} onClose={() => setPicking(false)} />
            )}
            {name && clean !== name.trim() && <span className="muted small">Saved as {clean || "…"}</span>}
            <button className="btn primary" disabled={!clean || busy}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </form>
        ) : (
          <form
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (folder.trim()) void act(() => p.onOpenFolder(folder.trim()));
            }}
          >
            <label>
              Folder
              <div className="row-input">
                <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={navigator.platform.startsWith("Win") ? "C:\\Users\\you\\code\\my-app" : "/Users/you/code/my-app"} spellCheck={false} />
                {desktop && (
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const picked = await window.multicodeDesktop!.pickFolder!();
                      if (picked) setFolder(picked);
                    }}
                  >
                    Browse…
                  </button>
                )}
              </div>
            </label>
            <p className="muted small">
              The crew works directly in this folder, with undo for every change. Your files stay where they are.
            </p>
            <button className="btn primary" disabled={!folder.trim() || busy}>
              {busy ? "Opening…" : "Open folder"}
            </button>
          </form>
        )}
        {error && <p className="err-text small">{error}</p>}
      </div>
    </dialog>
  );
}
