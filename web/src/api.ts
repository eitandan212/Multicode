import type {
  ConnectionView,
  CrewMember,
  HarnessSyncStatus,
  McpServer,
  SyncConfigView,
  ProjectInfo,
  ProviderKind,
  RunEvent,
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
  settings: Settings;
  projects: ProjectInfo[];
  clis: CliStatus[];
  defaultModels: Partial<Record<ProviderKind, string>>;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-multicode": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  state: () => request<AppState>("GET", "/api/state"),
  addConnection: (body: Record<string, unknown>) => request<ConnectionView>("POST", "/api/connections", body),
  updateConnection: (id: string, body: Record<string, unknown>) =>
    request<ConnectionView>("PATCH", `/api/connections/${id}`, body),
  deleteConnection: (id: string) => request<void>("DELETE", `/api/connections/${id}`),
  testConnection: (id: string, model?: string) =>
    request<{ ok: boolean; message: string }>("POST", `/api/connections/${id}/test`, { model }),
  models: (id: string) => request<{ models: string[]; error?: string }>("GET", `/api/connections/${id}/models`),
  saveCrew: (crew: CrewMember[]) => request<CrewMember[]>("PUT", "/api/crew", crew),
  saveSettings: (s: Partial<Settings>) => request<Settings>("PUT", "/api/settings", s),
  sync: () => request<SyncConfigView>("GET", "/api/sync"),
  saveSync: (body: { instructions?: string; mcpServers?: McpServer[]; env?: Record<string, string> }) =>
    request<SyncConfigView>("PUT", "/api/sync", body),
  syncProject: (project: string) => request<HarnessSyncStatus[]>("POST", `/api/projects/${project}/sync`),
  undo: (id: string, force = false) =>
    request<{ restored: string[]; conflicts: string[]; skipped: string[] }>("POST", `/api/runs/${id}/undo`, { force }),
  createProject: (name: string) => request<{ name: string }>("POST", "/api/projects", { name }),
  files: (project: string) => request<string[]>("GET", `/api/projects/${project}/files`),
  file: (project: string, path: string) =>
    request<{ content: string }>("GET", `/api/projects/${project}/file?path=${encodeURIComponent(path)}`),
  allRuns: () => request<RunSummary[]>("GET", "/api/runs"),
  runs: (project: string) => request<RunSummary[]>("GET", `/api/projects/${project}/runs`),
  startRun: (project: string, prompt: string) => request<RunSummary>("POST", `/api/projects/${project}/runs`, { prompt }),
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
