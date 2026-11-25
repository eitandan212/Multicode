// Who works on a run: MultiCode's automatic team, the user's crew, or one model alone.
import type { Connection } from "./config.js";
import { HttpError } from "./config.js";
import {
  connectionName,
  modelStrength,
  type CrewMember,
  type TeamChoice,
} from "./shared.js";

export { modelStrength };

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
