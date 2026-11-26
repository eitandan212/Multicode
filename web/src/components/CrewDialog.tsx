import { useEffect, useRef, useState } from "react";
import {
  connectionName,
  modelStrength,
  type CrewMember,
  type Role,
} from "../../../server/shared";
import { api, type AppState } from "../api";
import { colorFor, ROLE_HINT, ROLE_LABEL } from "../crewColors";
import { useOpenDialog } from "./embed";
import { Icon, type IconName } from "./Icon";
import { AGENT_PRESETS, type AgentPreset } from "../../../server/agents";
import { ProviderLogo } from "./ProviderLogo";

/** A free OpenCode model: plenty for coordinating the crew, and it costs nothing. */
const FREE_MANAGER = { model: "opencode/big-pickle" };

interface Props {
  state: AppState;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenConnections: () => void;
}

const ROLES: Role[] = ["architect", "builder", "reviewer"];

export function CrewDialog({
  state,
  onClose,
  onChanged,
  onOpenConnections,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  const [crew, setCrew] = useState<CrewMember[]>(() =>
    state.effectiveCrew.map((m) => ({
      ...m,
      id: m.id.startsWith("auto-") ? crypto.randomUUID() : m.id,
    })),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dispatch, setDispatch] = useState(state.settings.dispatch);
  const [collab, setCollab] = useState(state.settings.collaboration ?? "together");
  const [adding, setAdding] = useState(false);
  const [gallery, setGallery] = useState(false);
  const opencode = state.clis.find((c) => c.kind === "opencode-cli");
  const [manager, setManager] = useState(
    state.settings.manager ?? { mode: "auto" as const },
  );
  const managerKey = (m: typeof manager) =>
    m.mode === "pick" ? `pick:${m.connectionId}` : m.mode;
  const live = state.manager;

  /** Adds a free OpenCode connection; in Auto it becomes the manager at once. */
  const addFreeManager = async () => {
    setAdding(true);
    setError("");
    try {
      await api.addConnection({
        kind: "opencode-cli",
        defaultModel: FREE_MANAGER.model,
      });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  const conn = (id: string) => state.connections.find((c) => c.id === id);

  useEffect(() => {
    openDialog(ref.current);
  }, []);

  const update = (i: number, patch: Partial<CrewMember>) =>
    setCrew(crew.map((m, k) => (k === i ? { ...m, ...patch } : m)));

  const save = async () => {
    setSaving(true);
    try {
      await api.saveCrew(crew);
      if (
        dispatch !== state.settings.dispatch ||
        collab !== (state.settings.collaboration ?? "together") ||
        managerKey(manager) !==
          managerKey(state.settings.manager ?? { mode: "auto" })
      )
        await api.saveSettings({ dispatch, manager, collaboration: collab });
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
        <button
          className="icon-btn"
          onClick={() => ref.current?.close()}
          aria-label="Close"
        >
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
            <section className="dispatch-box">
              <div className="dispatch-head">
                {live && manager.mode !== "off" ? (
                  <ProviderLogo
                    kind={live.kind}
                    baseUrl={live.baseUrl}
                    model={live.model}
                    size={18}
                  />
                ) : (
                  <Icon name="spark" />
                )}
                <div>
                  <b>Manager</b>
                  <p className="muted small">
                    {manager.mode === "off"
                      ? "Off: the planner also decides who builds each task."
                      : live
                        ? `${live.name}${live.free && !/\(free\)/.test(live.name) ? " (free)" : ""} runs the crew: it assigns every task and, in Auto, picks who plans, builds and reviews. Your strongest model still does the thinking and planning.`
                        : "No free model yet. Add one below, or pick a cheap connection."}
                  </p>
                </div>
                <select
                  className="manager-select"
                  value={managerKey(manager)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setManager(
                      v.startsWith("pick:")
                        ? { mode: "pick", connectionId: v.slice(5) }
                        : { mode: v as "auto" | "off" },
                    );
                  }}
                  aria-label="Manager model"
                >
                  <option value="auto">Auto (a free model)</option>
                  {state.connections.map((c) => (
                    <option key={c.id} value={`pick:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                  <option value="off">Off</option>
                </select>
              </div>
              <div className="dispatch-tip">
                <span className="small muted">Task routing</span>
                <div
                  className="seg mini"
                  role="radiogroup"
                  aria-label="Dispatch mode"
                >
                  <button
                    role="radio"
                    aria-checked={dispatch === "smart"}
                    className={dispatch === "smart" ? "is-active" : ""}
                    onClick={() => setDispatch("smart")}
                  >
                    Smart
                  </button>
                  <button
                    role="radio"
                    aria-checked={dispatch === "balanced"}
                    className={dispatch === "balanced" ? "is-active" : ""}
                    onClick={() => setDispatch("balanced")}
                  >
                    Balanced
                  </button>
                </div>
                <span className="small muted collab-label">Building</span>
                <div className="seg mini" role="radiogroup" aria-label="How the crew builds">
                  <button
                    role="radio"
                    aria-checked={collab === "together"}
                    className={collab === "together" ? "is-active" : ""}
                    onClick={() => setCollab("together")}
                    title="Each task in a pair: one model writes, a second edits the same code, the first answers. They talk in a team chat."
                  >
                    Together
                  </button>
                  <button
                    role="radio"
                    aria-checked={collab === "split"}
                    className={collab === "split" ? "is-active" : ""}
                    onClick={() => setCollab("split")}
                    title="Each task by one model alone (fewer tokens)."
                  >
                    Split
                  </button>
                </div>
                {manager.mode === "auto" && !live?.free && (
                  <button
                    className="btn small push-right"
                    onClick={addFreeManager}
                    disabled={adding || !opencode?.installed}
                    title={
                      opencode?.installed
                        ? "Adds OpenCode's free Big Pickle model"
                        : opencode?.hint
                    }
                  >
                    {adding
                      ? "Adding…"
                      : opencode?.installed
                        ? "Add free manager"
                        : "Install OpenCode for a free manager"}
                  </button>
                )}
              </div>
            </section>
            {crew.map((m, i) => (
              <div
                key={m.id}
                className="edit-card"
                style={{ ["--agent" as string]: colorFor(crew, m.id) }}
              >
                <div className="edit-card-head">
                  {conn(m.connectionId) && (
                    <ProviderLogo
                      kind={conn(m.connectionId)!.kind}
                      acp={conn(m.connectionId)!.acp}
                      baseUrl={conn(m.connectionId)!.baseUrl}
                      model={m.model || conn(m.connectionId)!.defaultModel}
                    />
                  )}
                  {m.preset && PRESETS.get(m.preset) && (
                    <span
                      className="agent-tag"
                      title={PRESETS.get(m.preset)!.description}
                    >
                      <Icon
                        name={PRESETS.get(m.preset)!.icon as IconName}
                        size={12}
                      />
                      {PRESETS.get(m.preset)!.title}
                    </span>
                  )}
                  <input
                    className="name-input"
                    value={m.name}
                    maxLength={40}
                    onChange={(e) => update(i, { name: e.target.value })}
                    aria-label="Member name"
                  />
                  <button
                    className="icon-btn"
                    onClick={() => setCrew(crew.filter((_, k) => k !== i))}
                    aria-label={`Remove ${m.name}`}
                    title="Remove"
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Role</span>
                    <select
                      value={m.role}
                      onChange={(e) =>
                        update(i, { role: e.target.value as Role })
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Account</span>
                    <select
                      value={m.connectionId}
                      onChange={(e) => {
                        // Keep the harness name in sync unless the member was renamed by hand.
                        const old = conn(m.connectionId)?.label;
                        const next = conn(e.target.value)?.label;
                        update(i, {
                          connectionId: e.target.value,
                          ...(m.name === old && next ? { name: next } : {}),
                        });
                      }}
                    >
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
                      placeholder={
                        conn(m.connectionId)?.defaultModel ?? "Default"
                      }
                      onChange={(v) => {
                        const c = conn(m.connectionId);
                        const was = c
                          ? connectionName(
                              c.kind,
                              c.baseUrl,
                              m.model || c.defaultModel,
                            )
                          : "";
                        const next = c
                          ? connectionName(
                              c.kind,
                              c.baseUrl,
                              v || c.defaultModel,
                            )
                          : "";
                        update(i, {
                          model: v || undefined,
                          ...(m.name === was || m.name === c?.label
                            ? { name: next }
                            : {}),
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="field-row">
                  {m.role === "builder" && (
                    <label className="field narrow">
                      <span>Parallel agents</span>
                      <select
                        value={m.agents ?? 1}
                        onChange={(e) =>
                          update(i, { agents: Number(e.target.value) })
                        }
                      >
                        {[1, 2, 3, 4].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="field grow">
                    <span>Specialty or instructions</span>
                    <input
                      value={m.instructions ?? ""}
                      maxLength={1000}
                      placeholder={
                        m.role === "builder"
                          ? "e.g. UI and CSS, accessibility first"
                          : "Optional"
                      }
                      onChange={(e) =>
                        update(i, { instructions: e.target.value || undefined })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
            {gallery ? (
              <AgentGallery
                onPick={(preset) => {
                  setCrew([...crew, memberFor(preset, state.connections)]);
                  setGallery(false);
                }}
                onCustom={() => {
                  setCrew([
                    ...crew,
                    {
                      id: crypto.randomUUID(),
                      name: state.connections[0]!.label,
                      role: "builder",
                      connectionId: state.connections[0]!.id,
                      agents: 1,
                    },
                  ]);
                  setGallery(false);
                }}
                onClose={() => setGallery(false)}
              />
            ) : (
              <button
                className="btn ghost wide"
                disabled={crew.length >= 20}
                onClick={() => setGallery(true)}
              >
                <Icon name="users" size={14} /> Add agent
              </button>
            )}
            {error && <p className="err-text">{error}</p>}
            <div className="form-actions">
              <button
                className="btn ghost"
                onClick={() => ref.current?.close()}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={save}
                disabled={saving || crew.length === 0}
              >
                {saving ? "Saving…" : "Save crew"}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

const PRESETS = new Map(AGENT_PRESETS.map((p) => [p.id, p]));

/**
 * A new crew member for a specialist: frontier-needing agents get your strongest model, others
 * the next strongest, so work spreads across accounts. Named after its model, as every agent is.
 */
function memberFor(
  preset: AgentPreset,
  connections: AppState["connections"],
): CrewMember {
  const ranked = [...connections].sort(
    (a, b) =>
      modelStrength(b.kind, b.defaultModel) -
      modelStrength(a.kind, a.defaultModel),
  );
  const conn = (preset.strong ? ranked[0] : (ranked[1] ?? ranked[0]))!;
  return {
    id: crypto.randomUUID(),
    name: conn.defaultModel
      ? connectionName(conn.kind, conn.baseUrl, conn.defaultModel)
      : conn.label,
    role: preset.role,
    connectionId: conn.id,
    agents: 1,
    instructions: preset.instructions,
    preset: preset.id,
  };
}

const GROUPS: { role: AgentPreset["role"]; title: string }[] = [
  { role: "architect", title: "Plan" },
  { role: "builder", title: "Build" },
  { role: "reviewer", title: "Review" },
];

/** Ready-made specialists to add to the crew. */
function AgentGallery(p: {
  onPick: (preset: AgentPreset) => void;
  onCustom: () => void;
  onClose: () => void;
}) {
  return (
    <section className="agent-gallery" aria-label="Add an agent">
      <div className="agent-gallery-head">
        <b>Add an agent</b>
        <span className="muted small">
          Specialists keep your model's name; the specialty guides the planner,
          the manager and the agent.
        </span>
        <button
          className="icon-btn push-right"
          onClick={p.onClose}
          aria-label="Close"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      {GROUPS.map((g) => (
        <div key={g.role} className="agent-group">
          <span className="agent-group-title">{g.title}</span>
          <div className="agent-grid">
            {AGENT_PRESETS.filter((a) => a.role === g.role).map((a) => (
              <button
                key={a.id}
                className="agent-card"
                onClick={() => p.onPick(a)}
              >
                <span className="agent-icon">
                  <Icon name={a.icon as IconName} size={15} />
                </span>
                <span className="agent-text">
                  <b>{a.title}</b>
                  <span className="muted small">{a.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <button className="link small" onClick={p.onCustom}>
        Or add a custom agent
      </button>
    </section>
  );
}

const modelCache = new Map<string, Promise<string[]>>();

/** Free-text model field with suggestions from the connection's own model list. */
function ModelInput(props: {
  connectionId: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
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
      <input
        list={listId}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}
