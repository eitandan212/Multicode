import { useEffect, useRef, useState } from "react";
import { AgentSetup, canSignIn } from "./AgentSetup";
import {
  API_KINDS,
  CLI_KINDS,
  type AcpAgentView,
  KIND_LABELS,
  connectionName,
  FREELLMAPI_URL,
  OPEN_SOURCE_KINDS,
  SUBSCRIPTION_KINDS,
  type ConnectionView,
  type ProviderKind,
} from "../../../server/shared";
import { api, type AppState } from "../api";
import { useOpenDialog } from "./embed";
import { Icon } from "./Icon";
import { AgentIcon, hasBundledAgentLogo, ProviderLogo } from "./ProviderLogo";

interface Props {
  state: AppState;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

/** One-click endpoints for the OpenAI-compatible connection. */
const ENDPOINT_PRESETS: {
  name: string;
  url: string;
  model: string;
  free?: boolean;
  hint: string;
}[] = [
  {
    name: "FreeLLMAPI",
    url: FREELLMAPI_URL,
    model: "auto",
    free: true,
    hint: "80+ free providers behind one endpoint, with failover (runs on this computer)",
  },
  {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    hint: "Hundreds of models with one key",
  },
  { name: "Groq", url: "https://api.groq.com/openai/v1", model: "", hint: "Very fast open models" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-chat", hint: "DeepSeek's own API" },
  { name: "Mistral", url: "https://api.mistral.ai/v1", model: "", hint: "Mistral and Codestral" },
  { name: "xAI", url: "https://api.x.ai/v1", model: "", hint: "Grok models" },
  { name: "Together", url: "https://api.together.xyz/v1", model: "", hint: "Open models in the cloud" },
  { name: "Fireworks", url: "https://api.fireworks.ai/inference/v1", model: "", hint: "Open models in the cloud" },
  { name: "Cerebras", url: "https://api.cerebras.ai/v1", model: "", hint: "Very fast open models" },
  {
    name: "Ollama",
    url: "http://localhost:11434/v1",
    model: "qwen2.5-coder",
    free: true,
    hint: "Local models",
  },
  {
    name: "LM Studio",
    url: "http://localhost:1234/v1",
    model: "",
    free: true,
    hint: "Local models",
  },
];

/** APIs that speak Anthropic's Messages protocol at their own address. */
const ANTHROPIC_PRESETS: { name: string; url: string; hint: string }[] = [
  { name: "Anthropic", url: "", hint: "Anthropic's own API" },
  { name: "DeepSeek", url: "https://api.deepseek.com/anthropic", hint: "DeepSeek, Anthropic-compatible" },
  { name: "Kimi", url: "https://api.moonshot.ai/anthropic", hint: "Moonshot Kimi, Anthropic-compatible" },
  { name: "GLM (Z.ai)", url: "https://api.z.ai/api/anthropic", hint: "Z.ai GLM, Anthropic-compatible" },
];

/** "Name: value" lines → headers (blank lines ignored). */
function parseHeaderLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (!line.trim()) continue;
    if (i < 1) throw new Error(`Header lines look like "Name: value" (got "${line.trim()}")`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

const KEY_HELP: Partial<Record<ProviderKind, string>> = {
  anthropic: "console.anthropic.com → API keys",
  openai: "platform.openai.com → API keys",
  gemini: "aistudio.google.com → Get API key",
  "openai-compatible":
    "FreeLLMAPI's unified key, OpenRouter, Groq, DeepSeek, Together, or none for a local Ollama / LM Studio server",
};

const MODEL_HINT: Partial<Record<ProviderKind, string>> = {
  "opencode-cli": "provider/model, e.g. opencode/big-pickle (free)",
  "qwen-cli": "Leave empty for Qwen's default",
};

export function ConnectionsDialog({ state, onClose, onChanged }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  const [adding, setAdding] = useState<ProviderKind | null>(
    state.connections.length ? null : "claude-cli",
  );

  useEffect(() => {
    openDialog(ref.current);
  }, []);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-head">
        <div>
          <h2>Connections</h2>
          <p className="muted">
            Bring the AI accounts you already pay for. Keys stay on this
            computer.
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
            onCancel={
              state.connections.length ? () => setAdding(null) : undefined
            }
            onSaved={async () => {
              setAdding(null);
              await onChanged();
            }}
            onRefresh={onChanged}
          />
        ) : (
          <button
            className="btn ghost wide"
            onClick={() => setAdding("claude-cli")}
          >
            Add a connection
          </button>
        )}
      </div>
    </dialog>
  );
}

function ConnectionRow({
  conn,
  onChanged,
}: {
  conn: ConnectionView;
  onChanged: () => Promise<void>;
}) {
  const [test, setTest] = useState<{
    busy: boolean;
    ok?: boolean;
    message?: string;
  }>({ busy: false });
  const [confirming, setConfirming] = useState(false);

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await api.testConnection(conn.id);
      setTest({
        busy: false,
        ok: r.ok,
        message: r.ok ? `Connected: ${r.message}` : r.message,
      });
    } catch (e) {
      setTest({ busy: false, ok: false, message: (e as Error).message });
    }
  };

  return (
    <li className="conn-row">
      <span className="conn-logo">
        <ProviderLogo
          kind={conn.kind}
          acp={conn.acp}
          baseUrl={conn.baseUrl}
          model={conn.defaultModel}
          size={20}
        />
      </span>
      <div className="conn-main">
        <strong>{conn.label}</strong>
        <span className="muted small">
          {conn.kind === "acp"
            ? `ACP agent${conn.acp?.custom ? " · custom command" : ""}`
            : CLI_KINDS.includes(conn.kind)
              ? "Subscription via CLI"
              : `API key ${conn.keyHint ?? "not set"}`}
          {conn.defaultModel ? ` · ${conn.defaultModel}` : ""}
        </span>
        {test.message && (
          <span
            className={`small ${test.ok ? "ok-text" : "err-text"}`}
            role="status"
          >
            {test.ok ? "" : "Failed: "}
            {test.message}
          </span>
        )}
      </div>
      <div className="row-actions">
        <button className="btn small" onClick={runTest} disabled={test.busy}>
          {test.busy ? "Testing…" : "Test"}
        </button>
        {conn.kind === "openai-compatible" && (
          <button
            className="btn small"
            disabled={test.busy}
            title="Build a whole crew from this one key: free models plan and review, the best model builds"
            onClick={async () => {
              setTest({ busy: true });
              try {
                const crew = await api.autoCrew(conn.id);
                await onChanged();
                setTest({
                  busy: false,
                  ok: true,
                  message: `Crew ready: ${crew.map((m) => m.name).join(", ")}`,
                });
              } catch (e) {
                setTest({
                  busy: false,
                  ok: false,
                  message: (e as Error).message,
                });
              }
            }}
          >
            Auto crew
          </button>
        )}
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
          <button
            className="btn small ghost"
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

export function AddConnection(props: {
  kind: ProviderKind;
  state: AppState;
  onKind: (k: ProviderKind) => void;
  onCancel?: () => void;
  onSaved: () => Promise<void>;
  /** Re-reads the app state (after an install or a sign-in), keeping this form open. */
  onRefresh: () => Promise<void>;
}) {
  const { kind, state } = props;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [headers, setHeaders] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Antigravity is an agent too (it runs agy, not an API key), set up from its card.
  const isCli = CLI_KINDS.includes(kind) || kind === "antigravity";
  const cli = state.clis.find((c) => c.kind === kind);

  useEffect(() => {
    setError("");
    setModel(state.defaultModels[kind] ?? "");
    setModels([]);
    setBaseUrl(
      kind === "openai-compatible" ? "https://openrouter.ai/api/v1" : "",
    );
  }, [kind, state.defaultModels]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.addConnection({
        kind,
        apiKey,
        baseUrl,
        label: label || undefined,
        defaultModel: model,
        ...(headers.trim() ? { headers: parseHeaderLines(headers) } : {}),
      });
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
        {SUBSCRIPTION_KINDS.map((k) => (
          <KindOption key={k} kind={k} current={kind} onPick={props.onKind} />
        ))}
      </fieldset>
      <fieldset className="kind-picker">
        <legend>Use an open-source agent</legend>
        {OPEN_SOURCE_KINDS.map((k) => (
          <KindOption key={k} kind={k} current={kind} onPick={props.onKind} />
        ))}
      </fieldset>
      <fieldset className="kind-picker">
        <legend>Use an API key</legend>
        {API_KINDS.map((k) => (
          <KindOption key={k} kind={k} current={kind} onPick={props.onKind} />
        ))}
      </fieldset>
      <fieldset className="kind-picker">
        <legend>Use any coding agent</legend>
        <KindOption kind="acp" current={kind} onPick={props.onKind} />
      </fieldset>

      {kind === "acp" && (
        <AcpPicker onCancel={props.onCancel} onSaved={props.onSaved} />
      )}
      {kind !== "acp" && (
        <>
          {isCli && canSignIn(kind) && (
            <AgentSetup kind={kind} onReady={() => void props.onRefresh().catch(() => {})} />
          )}
          {isCli && cli && !canSignIn(kind) && (
            <div
              className={`cli-status ${cli.installed ? "is-ok" : "is-missing"}`}
            >
              {cli.installed ? (
                <>
                  <strong>{cli.binary} is installed.</strong>{" "}
                  {OPEN_SOURCE_KINDS.includes(kind)
                    ? `MultiCode runs this open-source agent on this computer. ${cli.hint.split("→")[1]?.trim() ?? ""}`
                    : "MultiCode runs it on this computer with your signed-in subscription. If you haven't signed in yet, run it once in a terminal."}
                </>
              ) : (
                <>
                  <strong>{cli.binary} isn't installed yet.</strong>{" "}
                  <InstallButton kind={kind} onDone={() => void props.onRefresh().catch(() => {})} />
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
                placeholder={
                  kind === "openai-compatible"
                    ? "Optional for local servers"
                    : "Paste your key"
                }
                required={kind !== "openai-compatible"}
              />
              {KEY_HELP[kind] && (
                <small className="muted">{KEY_HELP[kind]}</small>
              )}
            </label>
          )}
          {kind === "openai-compatible" && (
            <div
              className="endpoint-presets"
              role="group"
              aria-label="Quick setup"
            >
              {ENDPOINT_PRESETS.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  className={`chip preset-chip ${baseUrl === e.url ? "is-active" : ""}`}
                  onClick={() => {
                    setBaseUrl(e.url);
                    setModel(e.model);
                  }}
                  title={e.hint}
                >
                  {e.name}
                  {e.free && <span className="free-tag">free</span>}
                </button>
              ))}
            </div>
          )}
          {kind === "openai-compatible" && baseUrl === FREELLMAPI_URL && (
            <div className="cli-status is-ok">
              <strong>FreeLLMAPI</strong> puts 80+ free providers behind this
              one endpoint and fails over between them. Run it on this computer
              (<code>docker compose up</code> or its desktop app, see
              github.com/tashfeenahmed/freellmapi), add your free provider keys
              in its dashboard, then paste its unified <code>freellmapi-…</code>{" "}
              key here. Afterwards press <b>Auto crew</b> for a crew that costs
              nothing.
            </div>
          )}
          {kind === "anthropic" && (
            <div className="endpoint-presets" role="group" aria-label="Anthropic-compatible APIs">
              {ANTHROPIC_PRESETS.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  className={`chip preset-chip ${baseUrl === e.url ? "is-active" : ""}`}
                  onClick={() => setBaseUrl(e.url)}
                  title={e.hint}
                >
                  {e.name}
                </button>
              ))}
            </div>
          )}
          {!isCli && (
            <label className="field">
              <span>{kind === "openai-compatible" ? "Base URL" : "API address (optional)"}</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required={kind === "openai-compatible"}
                placeholder={
                  kind === "openai-compatible"
                    ? "https://…/v1"
                    : kind === "anthropic"
                      ? "Leave empty for Anthropic, or any Anthropic-compatible API"
                      : "Leave empty for the official API, or a proxy / gateway"
                }
              />
              {kind === "openai-compatible" && (
                <small className="muted">Any OpenAI-compatible API. Ollama: http://localhost:11434/v1</small>
              )}
            </label>
          )}
          {!isCli && (
            <details className="field extra-headers">
              <summary>Extra headers (optional)</summary>
              <textarea
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={"api-key: …\nX-Org-Id: …"}
              />
              <small className="muted">One per line, "Name: value". Kept on this computer like the key.</small>
            </details>
          )}
          <div className="field-row">
            <label className="field">
              <span>Default model</span>
              <div className="row-input">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list={models.length ? `models-${kind}` : undefined}
                placeholder={
                  MODEL_HINT[kind] ??
                  (isCli
                    ? "Leave empty for the CLI's default"
                    : "e.g. model id")
                }
                required={kind === "openai-compatible"}
              />
              {!isCli && (
                <button
                  type="button"
                  className="btn"
                  disabled={loadingModels || (kind === "openai-compatible" && !baseUrl)}
                  onClick={async () => {
                    setLoadingModels(true);
                    setError("");
                    try {
                      const r = await api.previewModels({
                        kind,
                        apiKey,
                        baseUrl,
                        ...(headers.trim() ? { headers: parseHeaderLines(headers) } : {}),
                      });
                      setModels(r.models);
                      if (r.error) setError(`Couldn't list models: ${r.error}`);
                      else if (!r.models.length) setError("This API didn't list any models; type the model id.");
                      else if (!model) setModel(r.models[0]!);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setLoadingModels(false);
                    }
                  }}
                >
                  {loadingModels ? "Loading…" : "Load models"}
                </button>
              )}
              </div>
              {models.length > 0 && (
                <datalist id={`models-${kind}`}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </label>
            <label className="field">
              <span>Name</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={connectionName(kind, baseUrl, model)}
                maxLength={80}
              />
            </label>
          </div>

          {error && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            {props.onCancel && (
              <button
                type="button"
                className="btn ghost"
                onClick={props.onCancel}
              >
                Cancel
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy || (isCli && cli !== undefined && !cli.installed)}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function KindOption({
  kind,
  current,
  onPick,
}: {
  kind: ProviderKind;
  current: ProviderKind;
  onPick: (k: ProviderKind) => void;
}) {
  return (
    <label className={`kind-option ${current === kind ? "is-active" : ""}`}>
      <input
        type="radio"
        name="kind"
        checked={current === kind}
        onChange={() => onPick(kind)}
      />
      <ProviderLogo kind={kind} size={15} />
      {KIND_LABELS[kind]}
    </label>
  );
}

/** The best-known coding agents lead the list; the rest follow alphabetically. */
const FEATURED_AGENTS = [
  "claude-acp",
  "codex-acp",
  "gemini",
  "github-copilot-cli",
  "cursor",
  "opencode",
  "qwen-code",
  "goose",
  "kiro",
  "qoder",
  "cline",
  "junie",
  "amp-acp",
  "devin",
  "factory-droid",
  "mistral-vibe",
  "kimi-code",
  "grok-build",
];

/**
 * Every agent in the Agent Client Protocol registry (Claude Code, Codex, Gemini CLI, Copilot,
 * Cursor, Goose, Kiro, Qoder…), connected the same way T3 Code connects them.
 */
function AcpPicker({
  onCancel,
  onSaved,
}: {
  onCancel?: () => void;
  onSaved: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<AcpAgentView[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");

  const load = async (refresh = false) => {
    const r = await api
      .acpAgents(refresh)
      .catch((e: Error) => ({ agents: [], error: e.message }));
    setAgents(r.agents);
    setError(r.error ?? "");
  };
  useEffect(() => {
    void load();
  }, []);

  const connect = async (body: Record<string, unknown>) => {
    await api.addConnection({ kind: "acp", acp: body });
    await onSaved();
  };
  const pick = async (a: AcpAgentView) => {
    setBusy(a.id);
    setError("");
    try {
      if (a.needsInstall) await api.installAcpAgent(a.id);
      await connect({ agentId: a.id, agentName: a.name, icon: a.icon });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const q = query.trim().toLowerCase();
  const rank = (id: string) => {
    const i = FEATURED_AGENTS.indexOf(id);
    return i < 0 ? FEATURED_AGENTS.length : i;
  };
  const shown = [...(agents ?? [])]
    .sort((x, y) => rank(x.id) - rank(y.id) || x.name.localeCompare(y.name))
    .filter(
      (a) =>
        !q ||
        `${a.name} ${a.id} ${a.description ?? ""}`.toLowerCase().includes(q),
    );

  return (
    <div className="acp">
      <p className="muted small">
        Agents that speak the open{" "}
        <a
          href="https://agentclientprotocol.com"
          target="_blank"
          rel="noreferrer"
        >
          Agent Client Protocol
        </a>
        . Each uses its own sign-in; MultiCode answers its file reads and writes
        inside the project and refuses shell commands.
      </p>
      <div className="acp-tools">
        <label className="search-field acp-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${agents?.length ?? ""} agents`}
            aria-label="Search agents"
          />
        </label>
        <button
          type="button"
          className="btn small ghost"
          onClick={() => void load(true)}
          title="Refresh the registry"
        >
          <Icon name="sync" size={13} /> Refresh
        </button>
      </div>
      {error && (
        <p className="err-text small" role="alert">
          {error}
        </p>
      )}
      {agents === null ? (
        <div className="acp-list">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="acp-row skeleton" />
          ))}
        </div>
      ) : (
        <ul className="acp-list">
          {shown.map((a) => (
            <li key={a.id} className="acp-row">
              <span className="acp-logo">
                {hasBundledAgentLogo(a.id) || !a.icon ? (
                  <ProviderLogo
                    kind="acp"
                    acp={{ agentId: a.id, icon: a.icon }}
                    size={18}
                  />
                ) : (
                  <AgentIcon icon={a.icon} size={18} />
                )}
              </span>
              <div className="acp-main">
                <strong>
                  {a.name}
                  {a.version && (
                    <span className="muted small"> {a.version}</span>
                  )}
                </strong>
                {a.description && (
                  <span className="muted small acp-desc">{a.description}</span>
                )}
                {a.reason && <span className="err-text small">{a.reason}</span>}
              </div>
              <button
                type="button"
                className={`btn small ${a.ready ? "" : "ghost"}`}
                disabled={busy !== null || Boolean(a.reason)}
                onClick={() => void pick(a)}
                title={
                  a.needsInstall
                    ? "Download it (checksum-verified) and connect"
                    : a.method
                      ? `Runs through ${a.method}`
                      : undefined
                }
              >
                {busy === a.id
                  ? a.needsInstall
                    ? "Installing…"
                    : "Connecting…"
                  : a.needsInstall
                    ? "Install"
                    : "Connect"}
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="muted small acp-empty">
              No agent matches “{query}”.
            </li>
          )}
        </ul>
      )}
      <label className="field">
        <span>Or a custom ACP command</span>
        <div className="acp-custom">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. my-agent --acp"
            maxLength={1000}
          />
          <button
            type="button"
            className="btn small"
            disabled={!custom.trim() || busy !== null}
            onClick={async () => {
              setBusy("custom");
              setError("");
              try {
                await connect({ command: custom.trim() });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            Connect
          </button>
        </div>
      </label>
      {onCancel && (
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** Installs an open-source agent with one click (npm, for this user). */
function InstallButton({ kind, onDone }: { kind: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="btn small primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await api.installAgent(kind);
            if (r.ok) onDone();
            else setError(r.output);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Installing…" : "Install"}
      </button>
      {error && <pre className="err-text small agent-error">{error}</pre>}
    </>
  );
}
