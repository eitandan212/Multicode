import { useEffect, useState } from "react";
import type { GitStatus } from "../../../server/shared";
import { api } from "../api";
import { Icon, Spinner } from "./Icon";

/** Version control on top of the Changes tab: branch, what changed, commit and push. */
export function GitBar({ project, refreshKey, suggestion }: { project: string; refreshKey: number; suggestion: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "commit" | "push" | "init">("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.git(project).then((s) => live && setStatus(s)).catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [project, refreshKey]);
  useEffect(() => setMessage(""), [project]);

  const act = async (kind: "commit" | "push" | "init") => {
    setBusy(kind);
    setNote(null);
    try {
      const s =
        kind === "init" ? await api.gitInit(project)
        : kind === "push" ? await api.gitPush(project)
        : await api.gitCommit(project, message.trim() || suggestion);
      setStatus(s);
      if (kind === "commit") setMessage("");
      setNote({ ok: true, text: kind === "init" ? "Version control is on." : kind === "push" ? "Pushed ✨" : "Committed ✨" });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  if (!status) return null;
  if (!status.installed)
    return (
      <div className="git-bar is-off">
        <Icon name="info" size={14} />
        <span className="muted small">Install Git (git-scm.com) to commit and push from here.</span>
      </div>
    );
  if (!status.repo)
    return (
      <div className="git-bar is-off">
        <Icon name="sync" size={14} />
        <span className="muted small">Not under version control.</span>
        <button className="btn small push-right" onClick={() => void act("init")} disabled={busy !== ""}>
          {busy === "init" ? <Spinner /> : null} Turn on Git
        </button>
        {note && <p className={`git-note ${note.ok ? "" : "err-text"} small`}>{note.text}</p>}
      </div>
    );

  const count = status.files.length;
  return (
    <div className="git-bar">
      <div className="git-head">
        <span className="git-branch" title={status.upstream ? `Tracks ${status.upstream}` : "No remote branch yet"}>
          <Icon name="sync" size={13} /> {status.branch}
        </span>
        <span className="muted small">
          {count ? `${count} change${count === 1 ? "" : "s"}` : "No changes"}
          {status.ahead ? ` · ${status.ahead} to push` : ""}
          {status.behind ? ` · ${status.behind} to pull` : ""}
        </span>
        {(status.ahead ?? 0) > 0 || (!status.upstream && count === 0) ? (
          <button
            className="btn small push-right"
            onClick={() => void act("push")}
            disabled={busy !== ""}
            title={status.upstream ? `Push to ${status.upstream}` : "Push this branch to origin"}
          >
            {busy === "push" ? <Spinner /> : <Icon name="arrowUp" size={13} />} Push
          </button>
        ) : null}
      </div>
      {count > 0 && (
        <form
          className="git-commit"
          onSubmit={(e) => {
            e.preventDefault();
            void act("commit");
          }}
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={suggestion}
            aria-label="Commit message"
            maxLength={5000}
          />
          <button className="btn small primary" disabled={busy !== ""}>
            {busy === "commit" ? <Spinner /> : <Icon name="check" size={13} />} Commit
          </button>
        </form>
      )}
      {note && <p className={`git-note small ${note.ok ? "muted pop-in" : "err-text"}`}>{note.text}</p>}
    </div>
  );
}
