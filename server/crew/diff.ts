import { structuredPatch } from "diff";
import type { FileDiff } from "../shared.js";
import type { Workspace } from "../workspace.js";

const MAX_DIFF_FILE = 400_000;
const MAX_BASELINE = 20_000_000;
const MAX_LINES_PER_FILE = 4_000;

/** Text contents of the project before a run, so its changes can be diffed afterwards. */
export async function captureBaseline(
  ws: Workspace,
): Promise<Map<string, string | null>> {
  const base = new Map<string, string | null>();
  let total = 0;
  for (const rel of await ws.list()) {
    const text = total < MAX_BASELINE ? await ws.tryRead(rel) : undefined;
    // null = existed but not diffable (binary, too large, or over the budget)
    if (
      text === undefined ||
      text.includes("\0") ||
      text.length > MAX_DIFF_FILE
    )
      base.set(rel, null);
    else {
      base.set(rel, text);
      total += text.length;
    }
  }
  return base;
}

export async function diffChanges(
  ws: Workspace,
  baseline: Map<string, string | null>,
  paths: string[],
): Promise<FileDiff[]> {
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const existed = baseline.has(path);
    const before = baseline.get(path);
    const after = await ws.tryRead(path);
    if (after === undefined && !existed) continue;
    const change: FileDiff["change"] = !existed
      ? "added"
      : after === undefined
        ? "deleted"
        : "modified";
    if (
      before === null ||
      (after !== undefined &&
        (after.includes("\0") || after.length > MAX_DIFF_FILE))
    ) {
      out.push({
        path,
        change,
        additions: 0,
        deletions: 0,
        hunks: [],
        skipped: true,
      });
      continue;
    }
    const patch = structuredPatch(
      path,
      path,
      before ?? "",
      after ?? "",
      "",
      "",
      { context: 3 },
    );
    let additions = 0;
    let deletions = 0;
    let budget = MAX_LINES_PER_FILE;
    const hunks = patch.hunks.flatMap((h) => {
      for (const l of h.lines) {
        if (l.startsWith("+")) additions++;
        else if (l.startsWith("-")) deletions++;
      }
      if (budget <= 0) return [];
      const lines = h.lines.slice(0, budget);
      budget -= lines.length;
      return [
        {
          header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
          lines,
        },
      ];
    });
    if (change === "modified" && additions === 0 && deletions === 0) continue;
    out.push({ path, change, additions, deletions, hunks });
  }
  return out;
}
