// Who works on a run: MultiCode's automatic team, the user's crew, or one model alone.
import type { Connection } from "./config.js";
import { HttpError } from "./config.js";
import {
  connectionName,
  isFreeModel,
  type CrewMember,
  type ProviderKind,
  type TeamChoice,
} from "./shared.js";

/** Default model strength when a connection names no model (the harness picks its own). */
const KIND_STRENGTH: Partial<Record<ProviderKind, number>> = {
  "claude-cli": 3,
  "codex-cli": 3,
  anthropic: 3,
  openai: 3,
  "gemini-cli": 2,
  gemini: 2,
  acp: 2,
};

/**
 * A rough capability rank (1 = light/free, 2 = strong, 3 = frontier), used only to decide
 * who plans and reviews in Auto. It never blocks a model; unknown models rank in the middle.
 */
export function modelStrength(kind: ProviderKind, model = ""): number {
  const m = model.toLowerCase();
  if (!m) return KIND_STRENGTH[kind] ?? 1;
  if (isFreeModel(m)) return 1;
  if (/(mini|nano|lite|haiku|flash-lite|small|tiny|[^\d]\d{1,2}b\b)/.test(m))
    return 1;
  if (
    /(opus|fable|gpt-5|\bo[34]\b|gemini-(2\.5-pro|[3-9])|grok-4|claude-sonnet-5)/.test(
      m,
    )
  )
    return 3;
  if (
    /(sonnet|gpt-4\.1|gpt-4o|gemini|deepseek|qwen3|kimi|glm-4|codestral|mistral-large|grok|llama-4)/.test(
      m,
    )
  )
    return 2;
  return 2;
}

/**
 * Auto: every connection joins. The strongest model plans, the next strongest reviews, and the
 * rest build in parallel (with two or fewer connections everyone also builds). The dispatcher
 * then gives each task to the best-fitting builder.
 */
export function autoTeam(connections: Connection[]): CrewMember[] {
  const ranked = connections
    .map((c, i) => ({ c, i, s: modelStrength(c.kind, c.defaultModel) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  return ranked.map(({ c }, rank) => ({
    id: `auto-${c.id}`,
    name: c.label,
    connectionId: c.id,
    role:
      ranked.length >= 3
        ? rank === 0
          ? "architect"
          : rank === 1
            ? "reviewer"
            : "builder"
        : rank === 0
          ? "architect"
          : "builder",
    agents: ranked.length >= 3 ? 1 : 2,
  }));
}

/** One model alone: it plans the work, builds it and reviews its own result. */
export function soloMember(conn: Connection, model?: string): CrewMember {
  const m = model || conn.defaultModel;
  return {
    id: `solo-${conn.id}`,
    name: m ? connectionName(conn.kind, conn.baseUrl, m) : conn.label,
    connectionId: conn.id,
    role: "builder",
    model: model || undefined,
    agents: 1,
  };
}

/** Validates a team choice from a request body. Missing means "crew" (the old behaviour). */
export function parseTeam(
  raw: unknown,
  connection: (id: string) => Connection | undefined,
): TeamChoice {
  if (raw === undefined || raw === null) return { kind: "crew" };
  const t = raw as Record<string, unknown>;
  if (t.kind === "auto" || t.kind === "crew") return { kind: t.kind };
  if (t.kind === "solo") {
    const connectionId =
      typeof t.connectionId === "string" ? t.connectionId : "";
    if (!connection(connectionId))
      throw new HttpError(400, "team.connectionId is unknown");
    const model =
      typeof t.model === "string" && t.model.trim()
        ? t.model.trim().slice(0, 200)
        : undefined;
    return { kind: "solo", connectionId, ...(model ? { model } : {}) };
  }
  throw new HttpError(400, "team.kind must be auto, crew or solo");
}
