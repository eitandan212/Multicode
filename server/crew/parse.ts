import type { Plan, PlanTask, Review, ReviewIssue } from "../shared.js";

export interface FileOp {
  path: string;
  change: "write" | "delete";
  content?: string;
}

/**
 * Parses `<file path="...">content</file>` and `<delete path="..."/>` blocks.
 * Tolerates a markdown code fence wrapping the content, and ignores everything else.
 */
export function parseFileOps(text: string): FileOp[] {
  const ops = new Map<string, FileOp>();
  const re = /<file\s+path\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/file>|<delete\s+path\s*=\s*["']([^"']+)["']\s*\/?>/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      let body = m[2] ?? "";
      body = body.replace(/^\r?\n/, "");
      const fenced = body.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
      if (fenced) body = fenced[1]!;
      if (body.length && !body.endsWith("\n")) body += "\n";
      ops.set(m[1].trim(), { path: m[1].trim(), change: "write", content: body });
    } else if (m[3] !== undefined) {
      ops.set(m[3].trim(), { path: m[3].trim(), change: "delete" });
    }
  }
  return [...ops.values()];
}

/** Finds the first JSON object in a model reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = fence ? [fence[1]!, text] : [text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start < 0) continue;
    // Walk to the matching closing brace, respecting strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export function parsePlan(text: string, request: string): Plan {
  const raw = extractJson(text) as { summary?: unknown; tasks?: unknown } | undefined;
  const tasks: PlanTask[] = [];
  if (raw && Array.isArray(raw.tasks)) {
    raw.tasks.slice(0, 12).forEach((t: unknown, i: number) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const title = asString(o.title).trim();
      if (!title) return;
      tasks.push({
        id: `t${i + 1}`,
        title: title.slice(0, 120),
        description: asString(o.description).slice(0, 4000),
        files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string").slice(0, 30) : [],
      });
    });
  }
  if (!tasks.length) {
    // Architect failed to produce a usable plan: fall back to a single task.
    return {
      summary: asString(raw?.summary) || "Build the requested change in one pass.",
      tasks: [{ id: "t1", title: "Implement the request", description: request, files: [] }],
    };
  }
  return { summary: asString(raw?.summary).slice(0, 2000), tasks };
}

export function parseReview(text: string): Review {
  const raw = extractJson(text) as { approved?: unknown; summary?: unknown; issues?: unknown } | undefined;
  if (!raw) return { approved: true, summary: "Reviewer gave no structured verdict; accepting.", issues: [] };
  const issues: ReviewIssue[] = Array.isArray(raw.issues)
    ? raw.issues
        .map((x: unknown) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return { file: asString(o.file), problem: asString(o.problem), fix: asString(o.fix) };
        })
        .filter((i) => i.problem)
        .slice(0, 20)
    : [];
  const approved = raw.approved === true || (raw.approved !== false && issues.length === 0);
  return { approved, summary: asString(raw.summary).slice(0, 2000), issues: approved ? [] : issues };
}
