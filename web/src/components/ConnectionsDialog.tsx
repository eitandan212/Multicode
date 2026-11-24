import { useEffect, useRef, useState } from "react";
import { API_KINDS, CLI_KINDS, KIND_LABELS, type ConnectionView, type ProviderKind } from "../../../server/shared";
import { api, type AppState } from "../api";
import { VENDOR } from "../crewColors";

interface Props {
  state: AppState;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const KEY_HELP: Partial<Record<ProviderKind, string>> = {
  anthropic: "console.anthropic.com → API keys",
  openai: "platform.openai.com → API keys",
  gemini: "aistudio.google.com → Get API key",
  "openai-compatible": "OpenRouter, Groq, DeepSeek, Together, or a local Ollama / LM Studio server",
};

export function ConnectionsDialog({ state, onClose, onChanged }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [adding, setAdding] = useState<ProviderKind | null>(state.connections.length ? null : "claude-cli");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Connections</h2>
          <p className="muted">Bring the AI accounts you already pay for. Keys stay on this computer.</p>
        </div>
        <button className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="dialog-body">
        {state.connections.length > 0 && (
          <ul className="conn-list">
            {state.connections.map((c) => (
              <ConnectionRow key={c.id} conn={c} onChanged={onChanged} />
            ))}
          </ul>
        )}

        {adding ? (
          <AddConnection
            kind={adding}
            state={state}
            onKind={setAdding}
            onCancel={state.connections.length ? () => setAdding(null) : undefined}
            onSaved={async () => {
              setAdding(null);
              await onChanged();
            }}
          />
        ) : (
          <button className="btn ghost wide" onClick={() => setAdding("claude-cli")}>
            Add a connection
          </button>
        )}
      </div>
    </dialog>
  );
}

function ConnectionRow({ conn, onChanged }: { conn: ConnectionView; onChanged: () => Promise<void> }) {
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  const [confirming, setConfirming] = useState(false);

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await api.testConnection(conn.id);
      setTest({ busy: false, ok: r.ok, message: r.message });
    } catch (e) {
      setTest({ busy: false, ok: false, message: (e as Error).message });
    }
  };

  return (
    <li className="conn-row">
      <span className={`vendor-chip v-${VENDOR[conn.kind].toLowerCase()}`}>{VENDOR[conn.kind]}</span>
      <div className="conn-main">
        <strong>{conn.label}</strong>
        <span className="muted small">
          {CLI_KINDS.includes(conn.kind) ? "Subscription via CLI" : `API key ${conn.keyHint ?? "not set"}`}
          {conn.defaultModel ? ` · ${conn.defaultModel}` : ""}
        </span>
        {test.message && (
          <span className={`small ${test.ok ? "ok-text" : "err-text"}`} role="status">
            {test.ok ? "Connected: " : "Failed: "}
            {test.message}
          </span>
        )}
      </div>
      <div className="row-actions">
        <button className="btn small" onClick={runTest} disabled={test.busy}>
          {test.busy ? "Testing…" : "Test"}
        </button>
        {confirming ? (
          <button
            className="btn small danger"
            onClick={async () => {
              await api.deleteConnection(conn.id);
              await onChanged();
            }}
          >
            Confirm remove
          </button>
        ) : (
          <button className="btn small ghost" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function AddConnection(props: {
  kind: ProviderKind;
  state: AppState;
  onKind: (k: ProviderKind) => void;
  onCancel?: () => void;
  onSaved: () => Promise<void>;
}) {
  const { kind, state } = props;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isCli = CLI_KINDS.includes(kind);
  const cli = state.clis.find((c) => c.kind === kind);

  useEffect(() => {
    setError("");
    setModel(state.defaultModels[kind] ?? "");
    setBaseUrl(kind === "openai-compatible" ? "https://openrouter.ai/api/v1" : "");
  }, [kind, state.defaultModels]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.addConnection({ kind, apiKey, baseUrl, label: label || undefined, defaultModel: model });
      await props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="add-conn"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="kind-picker">
        <legend>Use a subscription</legend>
        {CLI_KINDS.map((k) => (
          <KindOption key={k} kind={k} current={kind} onPick={props.onKind} />
        ))}
      </fieldset>
      <fieldset className="kind-picker">
        <legend>Use an API key</legend>
        {API_KINDS.map((k) => (
          <KindOption key={k} kind={k} current={kind} onPick={props.onKind} />
        ))}
      </fieldset>

      {isCli && cli && (
        <div className={`cli-status ${cli.installed ? "is-ok" : "is-missing"}`}>
          {cli.installed ? (
            <>
              <strong>{cli.binary} is installed.</strong> MultiCode runs it on this computer with your signed-in
              subscription. If you haven't signed in yet, run <code>{cli.binary}</code> once in a terminal.
            </>
          ) : (
            <>
              <strong>{cli.binary} isn't installed yet.</strong> In a terminal: <code>{cli.hint}</code>
            </>
          )}
        </div>
      )}

      {!isCli && (
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={kind === "openai-compatible" ? "Optional for local servers" : "Paste your key"}
            required={kind !== "openai-compatible"}
          />
          {KEY_HELP[kind] && <small className="muted">{KEY_HELP[kind]}</small>}
        </label>
      )}
      {kind === "openai-compatible" && (
        <label className="field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          <small className="muted">Ollama: http://localhost:11434/v1</small>
        </label>
      )}
      <div className="field-row">
        <label className="field">
          <span>Default model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={isCli ? "Leave empty for the CLI's default" : "e.g. model id"}
            required={kind === "openai-compatible"}
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={KIND_LABELS[kind]} maxLength={80} />
        </label>
      </div>

      {error && (
        <p className="err-text" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {props.onCancel && (
          <button type="button" className="btn ghost" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || (isCli && !cli?.installed)}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function KindOption({ kind, current, onPick }: { kind: ProviderKind; current: ProviderKind; onPick: (k: ProviderKind) => void }) {
  return (
    <label className={`kind-option ${current === kind ? "is-active" : ""}`}>
      <input type="radio" name="kind" checked={current === kind} onChange={() => onPick(kind)} />
      <span className={`vendor-dot v-${VENDOR[kind].toLowerCase()}`} aria-hidden />
      {KIND_LABELS[kind]}
    </label>
  );
}
