import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon, Spinner } from "./Icon";

type Skill = { name: string; description: string; body: string };

/** Your own skills: write one, install one from GitHub, edit or delete. */
export function CustomSkillsSection() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => void api.customSkills().then(setSkills).catch(() => setSkills([]));
  useEffect(load, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
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

  return (
    <section className="ext-section">
      <h3>Your skills</h3>
      <p className="muted small">
        Instructions every agent follows (Agent Skills format). Write one, install one from GitHub, or just ask in a
        chat: "install the skill from https://github.com/…".
      </p>
      {skills && skills.length > 0 && (
        <ul className="ext-list">
          {skills.map((s) => (
            <li key={s.name} className="custom-skill">
              <div className="custom-skill-text">
                <strong>{s.name}</strong>
                <span className="muted small">{s.description}</span>
              </div>
              <button className="icon-btn" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                <Icon name="pencil" size={14} />
              </button>
              <button
                className="icon-btn"
                title="Delete"
                aria-label={`Delete ${s.name}`}
                onClick={() => void run("del", () => api.deleteCustomSkill(s.name), `Deleted ${s.name}.`)}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <form
          className="custom-skill-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("save", () => api.saveCustomSkill(editing), `Saved ${editing.name || "the skill"}.`).then(() => setEditing(null));
          }}
        >
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="name, e.g. our-api-style"
            aria-label="Skill name"
            maxLength={48}
          />
          <input
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="When to use it, in one line"
            aria-label="Description"
            maxLength={300}
          />
          <textarea
            className="area"
            rows={8}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            placeholder={"# How we write API handlers\n\n- Validate input with zod\n- Return { error } with a status code"}
            aria-label="Instructions"
          />
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!editing.name.trim() || !editing.body.trim() || busy !== ""}>
              {busy === "save" ? <Spinner /> : null} Save skill
            </button>
          </div>
        </form>
      ) : (
        <div className="custom-skill-actions">
          <button className="btn small" onClick={() => setEditing({ name: "", description: "", body: "" })}>
            <Icon name="plus" size={13} /> Write a skill
          </button>
          <form
            className="git-commit"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) void run("install", () => api.installCustomSkill(url.trim()), "Installed.").then(() => setUrl(""));
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Install from a GitHub link to SKILL.md" aria-label="Skill address" spellCheck={false} />
            <button className="btn small" disabled={!url.trim() || busy !== ""}>
              {busy === "install" ? <Spinner /> : <Icon name="download" size={13} />} Install
            </button>
          </form>
        </div>
      )}
      {note && <p className={`small ${note.ok ? "muted pop-in" : "err-text"}`}>{note.text}</p>}
    </section>
  );
}
