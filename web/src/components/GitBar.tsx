import { useEffect, useState } from "react";
import type { GitStatus } from "../../../server/shared";
import { api } from "../api";
import { Icon, Spinner } from "./Icon";

/** Version control on top of the Changes tab: branch, what changed, commit and push. */
export function GitBar({ project, refreshKey, suggestion }: { project: string; refreshKey: number; suggestion: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "commit" | "push" | "init" | "pull" | "branch">("");
  const [branches, setBranches] = useState<{ current: string; branches: string[]; defaultBranch?: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.git(project).then((s) => live && setStatus(s)).catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [project, refreshKey]);
  useEffect(() => setMessage(""), [project]);
  useEffect(() => {
    if (!status?.repo) return;
    let live = true;
    api.gitBranches(project).then((b) => live && setBranches(b)).catch(() => {});
    return () => {
      live = false;
    };
  }, [project, status?.repo, status?.branch]);

  const branchAct = async (name: string, create: boolean) => {
    setBusy("branch");
    setNote(null);
    try {
      setStatus(await api.gitCheckout(project, name, create));
      setMenu(false);
      setNewBranch("");
      setNote({ ok: true, text: create ? `Created ${name} and switched to it.` : `Switched to ${name}.` });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const pull = async () => {
    setBusy("pull");
    setNote(null);
    try {
      setStatus(await api.gitPull(project));
      setNote({ ok: true, text: "Up to date with the remote." });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

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
        <button
          type="button"
          className="git-branch"
          onClick={() => setMenu(!menu)}
          aria-expanded={menu}
          title={`${status.upstream ? `Tracks ${status.upstream}. ` : ""}Switch or create a branch`}
        >
          <Icon name="sync" size={13} /> {status.branch}
          <Icon name="chevronDown" size={11} />
        </button>
        <span className="muted small">
          {count ? `${count} change${count === 1 ? "" : "s"}` : "No changes"}
          {status.ahead ? ` · ${status.ahead} to push` : ""}
          {status.behind ? ` · ${status.behind} to pull` : ""}
        </span>
        {status.upstream && (
          <button className="btn small" onClick={() => void pull()} disabled={busy !== ""} title="Bring in new commits from the remote">
            {busy === "pull" ? <Spinner /> : <Icon name="download" size={13} />} Pull
          </button>
        )}
        {status.github && status.upstream && branches?.defaultBranch && status.branch !== branches.defaultBranch && !(status.ahead ?? 0) && (
          <a
            className="btn small primary"
            href={`https://github.com/${status.github}/compare/${encodeURIComponent(status.branch ?? "")}?expand=1`}
            target="_blank"
            rel="noreferrer"
            title="Open a pull request for this branch on GitHub"
          >
            <Icon name="external" size={12} /> Open pull request
          </a>
        )}
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
      {menu && (
        <div className="git-branches pop-in">
          {(branches?.branches ?? []).map((b) => (
            <button key={b} type="button" className={`git-branch-item ${b === status.branch ? "is-current" : ""}`} disabled={busy !== "" || b === status.branch} onClick={() => void branchAct(b, false)}>
              {b === status.branch ? <Icon name="check" size={12} /> : <span className="git-dot" />}
              {b}
              {b === branches?.defaultBranch && <span className="muted small">default</span>}
            </button>
          ))}
          <form
            className="git-commit"
            onSubmit={(e) => {
              e.preventDefault();
              if (newBranch.trim()) void branchAct(newBranch.trim(), true);
            }}
          >
            <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="New branch, e.g. feature/login" aria-label="New branch name" spellCheck={false} />
            <button className="btn small" disabled={!newBranch.trim() || busy !== ""}>
              {busy === "branch" ? <Spinner /> : <Icon name="plus" size={13} />} Create
            </button>
          </form>
        </div>
      )}
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
