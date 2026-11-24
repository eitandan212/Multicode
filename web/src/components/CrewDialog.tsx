import { useEffect, useRef, useState } from "react";
import type { CrewMember, Role } from "../../../server/shared";
import { api, type AppState } from "../api";
import { colorFor, ROLE_HINT, ROLE_LABEL } from "../crewColors";
import { Icon } from "./Icon";

interface Props {
  state: AppState;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenConnections: () => void;
}

const ROLES: Role[] = ["architect", "builder", "reviewer"];

export function CrewDialog({ state, onClose, onChanged, onOpenConnections }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [crew, setCrew] = useState<CrewMember[]>(() =>
    state.effectiveCrew.map((m) => ({ ...m, id: m.id.startsWith("auto-") ? crypto.randomUUID() : m.id })),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const conn = (id: string) => state.connections.find((c) => c.id === id);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const update = (i: number, patch: Partial<CrewMember>) => setCrew(crew.map((m, k) => (k === i ? { ...m, ...patch } : m)));

  const save = async () => {
    setSaving(true);
    try {
      await api.saveCrew(crew);
      await onChanged();
      ref.current?.close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Crew</h2>
          <p className="muted">
            {ROLES.map((r) => (
              <span key={r} className="role-hint">
                <b>{ROLE_LABEL[r]}</b> {ROLE_HINT[r].toLowerCase()}.{" "}
              </span>
            ))}
          </p>
        </div>
        <button className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      <div className="dialog-body">
        {state.connections.length === 0 ? (
          <div className="empty-block">
            <p>Connect an AI first. Every connection can join the crew.</p>
            <button
              className="btn primary"
              onClick={() => {
                ref.current?.close();
                onOpenConnections();
              }}
            >
              Open connections
            </button>
          </div>
        ) : (
          <>
            {crew.map((m, i) => (
              <div key={m.id} className="edit-card" style={{ ["--agent" as string]: colorFor(crew, m.id) }}>
                <div className="edit-card-head">
                  <span className="member-dot" />
                  <input className="name-input" value={m.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} aria-label="Member name" />
                  <button className="icon-btn" onClick={() => setCrew(crew.filter((_, k) => k !== i))} aria-label={`Remove ${m.name}`} title="Remove">
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <div className="field-row">
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
                    <ModelInput
                      connectionId={m.connectionId}
                      value={m.model ?? ""}
                      placeholder={conn(m.connectionId)?.defaultModel ?? "Default"}
                      onChange={(v) => update(i, { model: v || undefined })}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button
              className="btn ghost wide"
              disabled={crew.length >= 20}
              onClick={() =>
                setCrew([...crew, { id: crypto.randomUUID(), name: `Agent ${crew.length + 1}`, role: "builder", connectionId: state.connections[0]!.id }])
              }
            >
              Add a member
            </button>
            {error && <p className="err-text">{error}</p>}
            <div className="form-actions">
              <button className="btn ghost" onClick={() => ref.current?.close()}>
                Cancel
              </button>
              <button className="btn primary" onClick={save} disabled={saving || crew.length === 0}>
                {saving ? "Saving…" : "Save crew"}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

const modelCache = new Map<string, Promise<string[]>>();

/** Free-text model field with suggestions from the connection's own model list. */
function ModelInput(props: { connectionId: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  const [models, setModels] = useState<string[]>([]);
  const listId = `models-${props.connectionId}`;

  useEffect(() => {
    let live = true;
    if (!modelCache.has(props.connectionId))
      modelCache.set(
        props.connectionId,
        api.models(props.connectionId).then(
          (r) => r.models,
          () => [],
        ),
      );
    void modelCache.get(props.connectionId)!.then((m) => live && setModels(m));
    return () => {
      live = false;
    };
  }, [props.connectionId]);

  return (
    <>
      <input list={listId} value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}
