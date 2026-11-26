import { McpQuickAdd } from "./McpQuickAdd";
import { useEffect, useRef, useState } from "react";
import type {
  HarnessSyncStatus,
  McpServer,
  ProviderKind,
} from "../../../server/shared";
import { api } from "../api";
import { useOpenDialog } from "./embed";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

const HARNESS_LOGO: Record<string, ProviderKind> = {
  "Claude Code": "claude-cli",
  Codex: "codex-cli",
  "Gemini CLI": "gemini-cli",
  "Qwen Code": "qwen-cli",
  OpenCode: "opencode-cli",
};

interface Draft extends McpServer {
  argsText: string;
  envText: string;
}

const toDraft = (s: McpServer): Draft => ({
  ...s,
  argsText: (s.args ?? []).join(" "),
  envText: (s.envNames ?? []).join(", "),
});

/**
 * One place for what every harness should share: standing instructions, MCP servers (and
 * their secrets), plus the project memory MultiCode keeps automatically.
 */
export function SyncDialog({
  project,
  onClose,
}: {
  project: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openDialog = useOpenDialog();
  const [instructions, setInstructions] = useState("");
  const [servers, setServers] = useState<Draft[]>([]);
  const [envSet, setEnvSet] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<HarnessSyncStatus[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    openDialog(ref.current);
    api.sync().then(
      (v) => {
        setInstructions(v.instructions);
        setServers(v.mcpServers.map(toDraft));
        setEnvSet(v.envSet);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const neededEnv = [
    ...new Set(
      servers.flatMap((s) => s.envText.split(/[\s,]+/).filter(Boolean)),
    ),
  ];

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const mcpServers: McpServer[] = servers.map((s) => ({
        name: s.name.trim(),
        type: s.type,
        ...(s.type === "http"
          ? { url: s.url?.trim() }
          : {
              command: s.command?.trim(),
              args: s.argsText.split(/\s+/).filter(Boolean),
            }),
        envNames: s.envText.split(/[\s,]+/).filter(Boolean),
      }));
      const env = Object.fromEntries(
        Object.entries(secrets).filter(([, v]) => v !== ""),
      );
      const v = await api.saveSync({ instructions, mcpServers, env });
      setEnvSet(v.envSet);
      setSecrets({});
      setStatus(await api.syncProject(project));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Draft>) =>
    setServers(servers.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  return (
    <dialog
      ref={ref}
      className="dialog sync-dialog"
      onClose={onClose}
      onCancel={onClose}
    >
      <header className="dialog-head">
        <div>
          <h2>Tools (MCP) & sync</h2>
          <p className="muted">
            Claude Code, Codex, Gemini CLI, Qwen Code and OpenCode all get the
            same instructions, tools and project memory.
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
        <label className="field">
          <span>Shared instructions</span>
          <textarea
            className="area"
            rows={5}
            value={instructions}
            maxLength={20000}
            placeholder="Conventions every agent should follow, e.g. “Use TypeScript and Tailwind. Keep components under 200 lines.”"
            onChange={(e) => setInstructions(e.target.value)}
          />
          <small className="muted">
            Written to AGENTS.md, CLAUDE.md, GEMINI.md and QWEN.md together with
            the project memory.
          </small>
        </label>

        <div className="field">
          <span>MCP servers</span>
          <McpQuickAdd
            names={new Set(servers.map((s) => s.name))}
            onAdd={(s) => setServers([...servers, toDraft(s)])}
            onImported={(saved, envSetNow) => {
              // Keep drafts you haven't saved yet next to the imported servers.
              const savedNames = new Set(saved.map((s) => s.name));
              setServers([...saved.map(toDraft), ...servers.filter((s) => s.name && !savedNames.has(s.name))]);
              setEnvSet(envSetNow);
            }}
          />
          {servers.length === 0 && (
            <p className="muted small">
              No shared tools yet. Add an MCP server and every agent that
              supports MCP can use it.
            </p>
          )}
          {servers.map((s, i) => (
            <div key={i} className="edit-card">
              <div className="field-row">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={s.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="docs"
                  />
                </label>
                <label className="field">
                  <span>Type</span>
                  <select
                    value={s.type}
                    onChange={(e) =>
                      update(i, { type: e.target.value as McpServer["type"] })
                    }
                  >
                    <option value="stdio">Local command</option>
                    <option value="http">Remote URL</option>
                  </select>
                </label>
                <button
                  className="icon-btn align-end"
                  onClick={() => setServers(servers.filter((_, k) => k !== i))}
                  aria-label={`Remove ${s.name || "server"}`}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              {s.type === "http" ? (
                <label className="field">
                  <span>URL</span>
                  <input
                    value={s.url ?? ""}
                    onChange={(e) => update(i, { url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </label>
              ) : (
                <div className="field-row">
                  <label className="field">
                    <span>Command</span>
                    <input
                      value={s.command ?? ""}
                      onChange={(e) => update(i, { command: e.target.value })}
                      placeholder="npx"
                    />
                  </label>
                  <label className="field grow">
                    <span>Arguments</span>
                    <input
                      value={s.argsText}
                      onChange={(e) => update(i, { argsText: e.target.value })}
                      placeholder="-y @upstash/context7-mcp"
                    />
                  </label>
                </div>
              )}
              <label className="field">
                <span>Environment variables it needs</span>
                <input
                  value={s.envText}
                  onChange={(e) =>
                    update(i, { envText: e.target.value.toUpperCase() })
                  }
                  placeholder="API_KEY, OTHER_TOKEN"
                />
              </label>
            </div>
          ))}
          <button
            className="btn ghost wide"
            disabled={servers.length >= 30}
            onClick={() =>
              setServers([
                ...servers,
                toDraft({ name: "", type: "stdio", command: "npx", args: [] }),
              ])
            }
          >
            Add MCP server
          </button>
        </div>

        {neededEnv.length > 0 && (
          <div className="field">
            <span>Secret values</span>
            <small className="muted">
              Kept in MultiCode's private config and handed to agents at run
              time. Project files only reference the names.
            </small>
            {neededEnv.map((n) => (
              <label key={n} className="field env-row">
                <code>{n}</code>
                <input
                  type="password"
                  autoComplete="off"
                  value={secrets[n] ?? ""}
                  placeholder={
                    envSet.includes(n) ? "Saved. Type to replace" : "Not set"
                  }
                  onChange={(e) =>
                    setSecrets({ ...secrets, [n]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
        )}

        {status && (
          <div className="sync-status" role="status">
            {status.length === 0 ? (
              <p className="muted small">
                Nothing to sync yet: add instructions or an MCP server.
              </p>
            ) : (
              status.map((h) => (
                <div key={h.harness} className="sync-row">
                  {HARNESS_LOGO[h.harness] && (
                    <ProviderLogo kind={HARNESS_LOGO[h.harness]!} />
                  )}
                  <b>{h.harness}</b>
                  <span className="muted truncate">{h.files.join(" · ")}</span>
                  <Icon name="check" size={14} className="ok-text push-right" />
                </div>
              ))
            )}
          </div>
        )}

        {error && <p className="err-text">{error}</p>}
        <div className="form-actions">
          <span className="muted small push-right-auto">
            Syncs into {project} now, and before every run.
          </span>
          <button className="btn primary" onClick={save} disabled={busy}>
            <Icon name="sync" size={14} /> {busy ? "Syncing…" : "Save and sync"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
