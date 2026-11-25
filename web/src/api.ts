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

export const api = {
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
  openFolder: (path: string) =>
    request<{ name: string }>("POST", "/api/projects/open", { path }),
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
  runs: (project: string) =>
    request<RunSummary[]>("GET", `/api/projects/${project}/runs`),
  startRun: (
    project: string,
    prompt: string,
    mode: RunMode = "build",
    team?: TeamChoice,
  ) =>
    request<RunSummary>("POST", `/api/projects/${project}/runs`, {
      prompt,
      mode,
      team,
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
