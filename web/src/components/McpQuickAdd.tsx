import { useState } from "react";
import type { McpServer } from "../../../server/shared";
import { api, type FoundMcpServer } from "../api";
import { Icon, Spinner } from "./Icon";

/** Popular remote MCP servers: one click adds them (they sign you in the first time an agent uses them). */
export const MCP_CATALOG: (McpServer & { label: string; hint: string })[] = [
  { label: "Linear", hint: "issues and projects", name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
  { label: "Notion", hint: "pages and databases", name: "notion", type: "http", url: "https://mcp.notion.com/mcp" },
  { label: "Sentry", hint: "errors and traces", name: "sentry", type: "http", url: "https://mcp.sentry.dev/mcp" },
  { label: "Stripe", hint: "payments", name: "stripe", type: "http", url: "https://mcp.stripe.com" },
  {
    label: "Supabase",
    hint: "database and auth",
    name: "supabase",
    type: "stdio",
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase@latest"],
    envNames: ["SUPABASE_ACCESS_TOKEN"],
  },
];

/**
 * The quick ways to connect tools: bring in what Claude Code, Codex, Cursor, Gemini CLI, Claude
 * Desktop or Windsurf already use, or add a popular server with one click.
 */
export function McpQuickAdd({
  names,
  onAdd,
  onImported,
}: {
  names: Set<string>;
  onAdd: (s: McpServer) => void;
  onImported: (servers: McpServer[], envSet: string[]) => void;
}) {
  const [found, setFound] = useState<FoundMcpServer[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"" | "find" | "import">("");
  const [error, setError] = useState("");
  const key = (f: FoundMcpServer) => `${f.source}|${f.name}`;

  const find = async () => {
    setBusy("find");
    setError("");
    try {
      const list = await api.discoverMcp();
      setFound(list);
      setPicked(new Set(list.filter((f) => !f.added).map(key)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const importPicked = async () => {
    setBusy("import");
    setError("");
    try {
      const chosen = (found ?? []).filter((f) => picked.has(key(f)));
      const v = await api.importMcp(chosen.map(({ source, name }) => ({ source, name })));
      onImported(v.mcpServers, v.envSet);
      setFound((list) => list?.map((f) => (picked.has(key(f)) ? { ...f, added: true } : f)) ?? null);
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const catalog = MCP_CATALOG.filter((c) => !names.has(c.name));
  return (
    <div className="mcp-quick">
      {catalog.length > 0 && (
        <div className="mcp-catalog">
          {catalog.map(({ label, hint, ...server }) => (
            <button key={server.name} type="button" className="mcp-chip" onClick={() => onAdd(server)} title={`Add ${label}: ${hint}`}>
              <Icon name="plus" size={12} /> {label}
              <span className="muted small">{hint}</span>
            </button>
          ))}
        </div>
      )}
      {!found ? (
        <button type="button" className="btn small" onClick={() => void find()} disabled={busy !== ""}>
          {busy === "find" ? <Spinner /> : <Icon name="download" size={13} />} Import from Claude Code, Codex, Cursor…
        </button>
      ) : found.length === 0 ? (
        <p className="muted small">No MCP servers found in Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop or Windsurf.</p>
      ) : (
        <div className="mcp-found">
          <span className="muted small">Found on this computer:</span>
          <ul>
            {found.map((f) => (
              <li key={key(f)} className="pop-in">
                <label>
                  <input
                    type="checkbox"
                    disabled={f.added}
                    checked={f.added || picked.has(key(f))}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(key(f));
                      else n.delete(key(f));
                      setPicked(n);
                    }}
                  />
                  <strong>{f.name}</strong>
                  <span className="muted small truncate">
                    {f.source} · {f.type === "http" ? f.url : [f.command, ...(f.args ?? [])].join(" ")}
                    {f.envNames.length ? ` · ${f.envNames.length} secret${f.envNames.length === 1 ? "" : "s"} copied` : ""}
                  </span>
                  {f.added && <span className="mcp-added">Added</span>}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn small primary" onClick={() => void importPicked()} disabled={busy !== "" || picked.size === 0}>
            {busy === "import" ? <Spinner /> : <Icon name="check" size={13} />} Import {picked.size || ""}
          </button>
        </div>
      )}
      {error && <p className="err-text small">{error}</p>}
    </div>
  );
}
