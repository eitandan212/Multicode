import type { Connection } from "./config.js";
import { connectionName, isFreeLlmApi, type CrewMember } from "./shared.js";

interface ModelInfo {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

const isFree = (m: ModelInfo) =>
  m.id.endsWith(":free") ||
  (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);

/**
 * Builds a whole crew from a single multi-model key (OpenRouter): free models plan and review,
 * and builders use OpenRouter's Auto Router, which picks a suitable model for every prompt.
 */
/**
 * FreeLLMAPI (github.com/tashfeenahmed/freellmapi) routes across 80+ free providers itself, so
 * its router models make a free crew: "auto:smart" plans, "auto" (or your "auto:coding"
 * profile, when you made one) builds in parallel, and "fusion" (several models + a judge) reviews.
 */
export function freeLlmApiCrew(conn: Connection, ids: string[]): CrewMember[] {
  const name = (id: string) => connectionName(conn.kind, conn.baseUrl, id);
  const builder = ids.some((m) => m.toLowerCase() === "auto:coding")
    ? "auto:coding"
    : "auto";
  const reviewer = ids.some((m) => m.toLowerCase() === "fusion")
    ? "fusion"
    : "auto:smart";
  const base = { connectionId: conn.id };
  return [
    {
      ...base,
      id: crypto.randomUUID(),
      name: name("auto:smart"),
      role: "architect",
      model: "auto:smart",
      agents: 1,
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: name(builder),
      role: "builder",
      model: builder,
      agents: 3,
      instructions:
        "General builder; FreeLLMAPI routes each call to a free model that fits.",
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: name(reviewer),
      role: "reviewer",
      model: reviewer,
      agents: 1,
    },
  ];
}

export async function autoCrew(
  conn: Connection,
  fetchImpl: typeof fetch = fetch,
): Promise<CrewMember[]> {
  if (!conn.baseUrl) throw new Error("This connection has no base URL.");
  const res = await fetchImpl(`${conn.baseUrl.replace(/\/$/, "")}/models`, {
    headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Could not list models (${res.status}).`);
  const data = ((await res.json()) as { data?: ModelInfo[] }).data ?? [];
  if (isFreeLlmApi(conn.baseUrl) || data.some((m) => m.id === "fusion"))
    return freeLlmApiCrew(
      conn,
      data.map((m) => m.id),
    );
  const free = data
    .filter(isFree)
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
  const isOpenRouter = /openrouter\.ai/i.test(conn.baseUrl);
  const builderModel = isOpenRouter
    ? "openrouter/auto"
    : (data.find((m) => !isFree(m)) ?? data[0])?.id;
  if (!builderModel) throw new Error("This endpoint lists no models.");
  const planner = free[0]?.id ?? builderModel;
  const checker = free[1]?.id ?? planner;
  const name = (id: string) => connectionName(conn.kind, conn.baseUrl, id);
  const base = { connectionId: conn.id };
  return [
    {
      ...base,
      id: crypto.randomUUID(),
      name: name(planner),
      role: "architect",
      model: planner,
      agents: 1,
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: name(builderModel),
      role: "builder",
      model: builderModel,
      agents: 3,
      instructions:
        "General builder; the router picks the best model for each task.",
    },
    {
      ...base,
      id: crypto.randomUUID(),
      name: name(checker),
      role: "reviewer",
      model: checker,
      agents: 1,
    },
  ];
}
