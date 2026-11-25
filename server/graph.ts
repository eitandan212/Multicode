import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes to the knowledge graph used by @modelcontextprotocol/server-memory: one JSON object
 * per line, `{type:"entity",name,entityType,observations}` or `{type:"relation",from,to,relationType}`.
 * MultiCode records every finished thread here, so all harnesses start from the same memory.
 */
interface Entity {
  type: "entity";
  name: string;
  entityType: string;
  observations: string[];
}
interface Relation {
  type: "relation";
  from: string;
  to: string;
  relationType: string;
}
type Line = Entity | Relation;

const MAX_OBSERVATIONS = 40;

export interface RunRecord {
  project: string;
  prompt: string;
  summary: string;
  files: string[];
  agents: { name: string; harness: string; files: string[] }[];
  at: number;
}

export async function recordRun(file: string, r: RunRecord): Promise<void> {
  const lines: Line[] = [];
  const raw: string[] = [];
  try {
    for (const l of (await readFile(file, "utf8")).split("\n")) {
      if (!l.trim()) continue;
      try {
        lines.push(JSON.parse(l) as Line);
      } catch {
        raw.push(l); // keep anything we don't understand
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const entities = new Map(
    lines
      .filter((l): l is Entity => l.type === "entity")
      .map((e) => [e.name, e]),
  );
  const relations = lines.filter((l): l is Relation => l.type === "relation");
  const relKey = (x: Relation) =>
    `${x.from}\u0000${x.relationType}\u0000${x.to}`;
  const relSet = new Set(relations.map(relKey));

  const observe = (name: string, entityType: string, observation: string) => {
    const e = entities.get(name) ?? {
      type: "entity" as const,
      name,
      entityType,
      observations: [],
    };
    if (!e.observations.includes(observation))
      e.observations = [...e.observations, observation].slice(
        -MAX_OBSERVATIONS,
      );
    entities.set(name, e);
  };
  const relate = (from: string, relationType: string, to: string) => {
    const rel: Relation = { type: "relation", from, to, relationType };
    if (!relSet.has(relKey(rel))) {
      relations.push(rel);
      relSet.add(relKey(rel));
    }
  };

  const day = new Date(r.at).toISOString().slice(0, 10);
  const short = (t: string, n: number) =>
    (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/\s+/g, " ").trim();
  const project = `project:${r.project}`;
  observe(
    project,
    "project",
    `${day}: "${short(r.prompt, 160)}" → ${short(r.summary, 300)}`,
  );
  for (const f of r.files) {
    const node = `file:${f}`;
    observe(node, "file", `${day}: changed for "${short(r.prompt, 100)}"`);
    relate(project, "contains", node);
  }
  for (const a of r.agents) {
    const node = `agent:${a.name}`;
    observe(node, "agent", `${a.harness}`);
    for (const f of a.files) relate(node, "edited", `file:${f}`);
    relate(node, "works on", project);
  }

  const out = [...entities.values(), ...relations]
    .map((l) => JSON.stringify(l))
    .concat(raw);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, out.join("\n") + "\n");
  await rename(tmp, file);
}

export interface MemoryGraph {
  entities: { name: string; entityType: string; observations: string[] }[];
  relations: { from: string; to: string; relationType: string }[];
}

/** The project's memory graph as the memory MCP server and MultiCode wrote it. */
export async function readGraph(file: string): Promise<MemoryGraph> {
  const graph: MemoryGraph = { entities: [], relations: [] };
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return graph;
  }
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l) as {
        type?: string;
        name?: unknown;
        entityType?: unknown;
        observations?: unknown;
        from?: unknown;
        to?: unknown;
        relationType?: unknown;
      };
      if (x.type === "entity" && typeof x.name === "string")
        graph.entities.push({
          name: x.name,
          entityType: String(x.entityType ?? "thing"),
          observations: Array.isArray(x.observations) ? x.observations.map(String) : [],
        });
      else if (x.type === "relation" && typeof x.from === "string" && typeof x.to === "string")
        graph.relations.push({ from: x.from, to: x.to, relationType: String(x.relationType ?? "") });
    } catch {
      /* a line the memory server may add later: skip it */
    }
  }
  return graph;
}
