import type {
  AcpAgentView,
  ManagerView,
  TeamChoice,
  ConnectionView,
  CrewMember,
  ExtensionsView,
  HarnessSyncStatus,
  McpServer,
  SyncConfigView,
  ProjectInfo,
  ProviderKind,
  RunEvent,
  RunMode,
  RunSummary,
  Settings,
} from "../../server/shared";

export interface CliStatus {
  kind: ProviderKind;
  binary: string;
  installed: boolean;
  hint: string;
}

export interface AppState {
  connections: ConnectionView[];
  crew: CrewMember[];
  effectiveCrew: CrewMember[];
  manager: ManagerView | null;
  settings: Settings;
  projects: ProjectInfo[];
  clis: CliStatus[];
  defaultModels: Partial<Record<ProviderKind, string>>;
  /** connectionId -> when its usage limit resets. */
  limits: Record<string, number>;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-multicode": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      (data as { error?: string }).error ?? `Request failed (${res.status})`,
    );
  return data as T;
}

import type { AccountUsage, AgentAccess, ConnectionHealth, GitStatus, SignInFlow } from "../../server/shared";
export type { AgentAccess, ConnectionHealth, SignInFlow };

/** An MCP server found in another tool's config (values stay on the server). */
export interface FoundMcpServer {
  source: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envNames: string[];
  added: boolean;
}

export const api = {
  /** Saves a pasted or dropped picture in the project; mention the returned path with @. */
  attach: async (project: string, file: Blob): Promise<{ path: string }> => {
    const res = await fetch(`/api/projects/${project}/attachments`, {
      method: "POST",
      headers: { "content-type": file.type, "x-multicode": "1" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `Upload failed (${res.status})`);
    return data as { path: string };
  },
  git: (project: string) => request<GitStatus>("GET", `/api/projects/${project}/git`),
  gitInit: (project: string) => request<GitStatus>("POST", `/api/projects/${project}/git/init`),
  gitCommit: (project: string, message: string) =>
    request<GitStatus>("POST", `/api/projects/${project}/git/commit`, { message }),
  gitPush: (project: string) => request<GitStatus>("POST", `/api/projects/${project}/git/push`),
  gitPull: (project: string) => request<GitStatus>("POST", `/api/projects/${project}/git/pull`),
  gitBranches: (project: string) =>
    request<{ current: string; branches: string[]; defaultBranch?: string }>("GET", `/api/projects/${project}/git/branches`),
  gitCheckout: (project: string, branch: string, create = false) =>
    request<GitStatus>("POST", `/api/projects/${project}/git/checkout`, { branch, create }),
  cloneRepo: (url: string) => request<{ name: string }>("POST", "/api/projects/clone", { url }),
  attachmentUrl: (project: string, rel: string) =>
    `/api/projects/${project}/attachments/${rel.replace(/^\.attachments\//, "")}`,
  state: () => request<AppState>("GET", "/api/state"),
  addConnection: (body: Record<string, unknown>) =>
    request<ConnectionView>("POST", "/api/connections", body),
  updateConnection: (id: string, body: Record<string, unknown>) =>
    request<ConnectionView>("PATCH", `/api/connections/${id}`, body),
  acpAgents: (refresh = false) =>
    request<{ agents: AcpAgentView[]; error?: string }>(
      "GET",
      `/api/acp/agents${refresh ? "?refresh=1" : ""}`,
    ),
  installAcpAgent: (id: string) =>
    request<{ ok: boolean; agent: AcpAgentView }>(
      "POST",
      `/api/acp/agents/${encodeURIComponent(id)}/install`,
    ),
  deleteConnection: (id: string) =>
    request<void>("DELETE", `/api/connections/${id}`),
  testConnection: (id: string, model?: string) =>
    request<{ ok: boolean; message: string }>(
      "POST",
      `/api/connections/${id}/test`,
      { model },
    ),
  models: (id: string) =>
    request<{ models: string[]; error?: string }>(
      "GET",
      `/api/connections/${id}/models`,
    ),
  saveCrew: (crew: CrewMember[]) =>
    request<CrewMember[]>("PUT", "/api/crew", crew),
  saveSettings: (s: Partial<Settings>) =>
    request<Settings>("PUT", "/api/settings", s),
  extensions: () => request<ExtensionsView>("GET", "/api/extensions"),
  saveExtensions: (body: Record<string, unknown>) =>
    request<ExtensionsView>("PUT", "/api/extensions", body),
  sync: () => request<SyncConfigView>("GET", "/api/sync"),
  commands: (project: string) =>
    request<{ name: string; description: string; body: string; source: string }[]>("GET", `/api/projects/${project}/commands`),
  cacheCheck: (id: string) =>
    request<{ ok: boolean; model: string; first: { input: number; cached: number }; second: { input: number; cached: number }; message: string }>(
      "POST",
      `/api/connections/${id}/cache-check`,
    ),
  discoverMcp: () => request<FoundMcpServer[]>("GET", "/api/mcp/discover"),
  importMcp: (servers: { source: string; name: string }[]) =>
    request<SyncConfigView>("POST", "/api/mcp/import", { servers }),
  saveSync: (body: {
    instructions?: string;
    mcpServers?: McpServer[];
    env?: Record<string, string>;
  }) => request<SyncConfigView>("PUT", "/api/sync", body),
  syncProject: (project: string) =>
    request<HarnessSyncStatus[]>("POST", `/api/projects/${project}/sync`),
  undo: (id: string, force = false) =>
    request<{ restored: string[]; conflicts: string[]; skipped: string[] }>(
      "POST",
      `/api/runs/${id}/undo`,
      { force },
    ),
  createProject: (name: string) =>
    request<{ name: string }>("POST", "/api/projects", { name }),
  memory: (project: string) =>
    request<{
      entities: { name: string; entityType: string; observations: string[] }[];
      relations: { from: string; to: string; relationType: string }[];
    }>("GET", `/api/projects/${project}/memory`),
  about: () =>
    request<{ version: string; dataDir: string | null; projectsDir: string; errorLog: string | null; node: string; platform: string }>("GET", "/api/about"),
  usage: (fresh = false) => request<AccountUsage[]>("GET", `/api/usage${fresh ? "?fresh=1" : ""}`),
  checkConnection: (id: string) => request<ConnectionHealth>("GET", `/api/connections/${id}/check`),
  agentAccess: (kind: string) => request<AgentAccess>("GET", `/api/agents/${kind}/access`),
  installAgent: (kind: string) =>
    request<{ ok: boolean; output: string }>("POST", `/api/agents/${kind}/install`),
  startSignIn: (kind: string) => request<SignInFlow>("POST", `/api/agents/${kind}/signin`),
  signInFlow: (id: string) => request<SignInFlow>("GET", `/api/signin/${id}`),
  signInCode: (id: string, code: string) => request<void>("POST", `/api/signin/${id}/code`, { code }),
  cancelSignIn: (id: string) => request<void>("POST", `/api/signin/${id}/cancel`),
  approve: (runId: string, approvalId: string, allow: boolean, always = false) =>
    request<void>("POST", `/api/runs/${runId}/approvals/${approvalId}`, { allow, always }),
  previewModels: (body: { kind: string; apiKey?: string; baseUrl?: string; headers?: Record<string, string> }) =>
    request<{ models: string[]; error?: string }>("POST", "/api/models/preview", body),
  setProjectEmoji: (name: string, emoji: string | null) =>
    request<void>("PUT", `/api/projects/${name}/emoji`, { emoji }),
  openFolder: (path: string) =>
    request<{ name: string }>("POST", "/api/projects/open", { path }),
  setProjectCheck: (name: string, check: string) =>
    request<void>("PUT", `/api/projects/${name}/check`, { check }),
  unlinkProject: (name: string) =>
    request<void>("POST", `/api/projects/${name}/unlink`),
  saveFile: (project: string, path: string, content: string) =>
    request<{ ok: boolean }>("PUT", `/api/projects/${project}/file`, {
      path,
      content,
    }),
  deleteFile: (project: string, path: string) =>
    request<void>(
      "DELETE",
      `/api/projects/${project}/file?path=${encodeURIComponent(path)}`,
    ),
  files: (project: string) =>
    request<string[]>("GET", `/api/projects/${project}/files`),
  file: (project: string, path: string) =>
    request<{ content: string }>(
      "GET",
      `/api/projects/${project}/file?path=${encodeURIComponent(path)}`,
    ),
  allRuns: () => request<RunSummary[]>("GET", "/api/runs"),
  updateChat: (id: string, patch: { title?: string | null; pinned?: boolean; archived?: boolean }) =>
    request<RunSummary>("PATCH", `/api/chats/${id}`, patch),
  deleteChat: (id: string) => request<void>("DELETE", `/api/chats/${id}`),
  runs: (project: string) =>
    request<RunSummary[]>("GET", `/api/projects/${project}/runs`),
  startRun: (
    project: string,
    prompt: string,
    mode: RunMode = "build",
    team?: TeamChoice,
    sleep = false,
    parentId?: string,
    review = false,
    parallel = false,
  ) =>
    request<RunSummary>("POST", `/api/projects/${project}/runs`, {
      prompt,
      mode,
      team,
      ...(sleep ? { sleep: true } : {}),
      ...(parentId ? { parentId } : {}),
      ...(review ? { review: true } : {}),
      ...(parallel ? { parallel: true } : {}),
    }),
  apply: (id: string, variant?: string, force = false) =>
    request<{ applied: string[]; conflicts: string[] }>(
      "POST",
      `/api/runs/${id}/apply`,
      { variant, force },
    ),
  discard: (id: string) =>
    request<{ ok: boolean }>("POST", `/api/runs/${id}/discard`),
  resetLimit: (connectionId: string) =>
    request<{ ok: boolean }>(
      "POST",
      `/api/connections/${connectionId}/limit-reset`,
    ),
  autoCrew: (connectionId: string) =>
    request<CrewMember[]>("POST", `/api/connections/${connectionId}/auto-crew`),
  cancelRun: (id: string) => request<void>("POST", `/api/runs/${id}/cancel`),
  events(id: string, onEvent: (e: RunEvent) => void): () => void {
    const source = new EventSource(`/api/runs/${id}/events`);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data) as RunEvent;
      onEvent(e);
      if (e.type === "run.done" || e.type === "run.error") source.close();
    };
    return () => source.close();
  },
};
