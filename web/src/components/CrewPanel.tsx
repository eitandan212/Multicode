import { useState } from "react";
import type { CrewMember, Role } from "../../../server/shared";
import { api, type AppState } from "../api";
import { colorFor, initials, ROLE_HINT, ROLE_LABEL, VENDOR } from "../crewColors";

interface Props {
  state: AppState;
  busyMembers: Set<string>;
  onChanged: () => Promise<void>;
  onOpenConnections: () => void;
}

const ROLES: Role[] = ["architect", "builder", "reviewer"];

export function CrewPanel({ state, busyMembers, onChanged, onOpenConnections }: Props) {
  const [editing, setEditing] = useState<CrewMember[] | null>(null);
  const [error, setError] = useState("");
  const crew = state.effectiveCrew;
  const conn = (id: string) => state.connections.find((c) => c.id === id);

  if (!state.connections.length) {
    return (
      <div className="crew-empty">
        <h2>Your crew is empty</h2>
        <p className="muted">Connect a Claude, ChatGPT or Gemini account, by subscription or API key, and it joins the crew.</p>
        <button className="btn primary wide" onClick={onOpenConnections}>
          Connect an AI
        </button>
      </div>
    );
  }

  if (editing) {
    const update = (i: number, patch: Partial<CrewMember>) =>
      setEditing(editing.map((m, k) => (k === i ? { ...m, ...patch } : m)));
    return (
      <div className="crew-edit">
        <h2>Edit crew</h2>
        {editing.map((m, i) => (
          <div key={m.id} className="edit-card" style={{ ["--agent" as string]: colorFor(editing, m.id) }}>
            <div className="field-row">
              <label className="field">
                <span>Name</span>
                <input value={m.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>Role</span>
                <select value={m.role} onChange={(e) => update(i, { role: e.target.value as Role })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Account</span>
                <select value={m.connectionId} onChange={(e) => update(i, { connectionId: e.target.value })}>
                  {state.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <input
                  value={m.model ?? ""}
                  placeholder={conn(m.connectionId)?.defaultModel ?? "Default"}
                  onChange={(e) => update(i, { model: e.target.value || undefined })}
                />
              </label>
            </div>
            <button className="btn small ghost" onClick={() => setEditing(editing.filter((_, k) => k !== i))}>
              Remove from crew
            </button>
          </div>
        ))}
        <button
          className="btn ghost wide"
          disabled={editing.length >= 20}
          onClick={() =>
            setEditing([
              ...editing,
              { id: crypto.randomUUID(), name: `Agent ${editing.length + 1}`, role: "builder", connectionId: state.connections[0]!.id },
            ])
          }
        >
          Add a member
        </button>
        {error && <p className="err-text">{error}</p>}
        <div className="form-actions">
          <button className="btn ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await api.saveCrew(editing);
                setEditing(null);
                setError("");
                await onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Save crew
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="crew">
      <div className="panel-head">
        <h2>Crew</h2>
        <button className="btn small ghost" onClick={() => setEditing(crew.map((m) => ({ ...m, id: m.id.startsWith("auto-") ? crypto.randomUUID() : m.id })))}>
          Edit
        </button>
      </div>
      <ul className="roster">
        {crew.map((m) => {
          const c = conn(m.connectionId);
          const busy = busyMembers.has(m.id);
          return (
            <li key={m.id} className={`member ${busy ? "is-busy" : ""}`} style={{ ["--agent" as string]: colorFor(crew, m.id) }}>
              <span className="avatar" aria-hidden>
                {initials(m.name)}
              </span>
              <div className="member-main">
                <strong>{m.name}</strong>
                <span className="muted small">
                  {ROLE_LABEL[m.role]} · {c ? VENDOR[c.kind] : "missing account"}
                  {m.model || c?.defaultModel ? ` · ${m.model || c?.defaultModel}` : ""}
                </span>
              </div>
              <span className="member-state small" title={ROLE_HINT[m.role]}>
                {busy ? "working" : "ready"}
              </span>
            </li>
          );
        })}
      </ul>
      {!state.crew.length && (
        <p className="muted small crew-note">
          Every connected account is on the crew. The first one plans and reviews. Edit the crew to give each member a role.
        </p>
      )}
      <button className="btn ghost wide" onClick={onOpenConnections}>
        Connections ({state.connections.length})
      </button>
      <label className="field compact">
        <span>Review rounds</span>
        <select
          value={state.settings.maxReviewRounds}
          onChange={async (e) => {
            await api.saveSettings({ maxReviewRounds: Number(e.target.value) });
            await onChanged();
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "No review" : n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
