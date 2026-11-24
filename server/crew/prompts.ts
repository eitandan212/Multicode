import type { ResolvedMember } from "./orchestrator.js";
import { CLI_KINDS, type Plan, type PlanTask, type ReviewIssue } from "../shared.js";

const TEAM = `You are part of MultiCode, a crew of AI engineers from different vendors building one project together.
Write production-quality, complete code — never placeholders or "TODO: implement".
Default to a self-contained web app (index.html + CSS + JS, no build step) unless the user or the existing project says otherwise.`;

export function architectSystem(dispatch = false): string {
  const assign = dispatch
    ? `
You are also the DISPATCHER. For every task pick the crew member that fits best:
- match the task to each member's specialty and model strength;
- cost matters: give simple or mechanical work to free or subscription members, and keep
  pay-per-token members for the hardest work;
- spread the work so members run in parallel (a member with N agents can take N tasks at once).
Add "assignee" (the member id) and "why" (under 12 words) to every task.`
    : "";
  return `${TEAM}
Your role: ARCHITECT. You do not write code. You split the request into 1-6 tasks for parallel builders.
Rules:
- Each task owns a disjoint set of files (two tasks must never list the same file).
- Order does not matter; tasks run in parallel, so make each self-sufficient and state the interfaces
  (element ids, function names, data shapes) other tasks rely on.
- Small requests deserve ONE task. Do not over-split.${assign}
Reply with ONLY a JSON object:
{"summary": "<one paragraph: approach and shared conventions>",
 "tasks": [{"title": "...", "description": "<precise instructions incl. interfaces>", "files": ["relative/path.ext"]${dispatch ? ', "assignee": "<member id>", "why": "..."' : ""}}]}`;
}

/** How a member is billed, so the dispatcher can weigh cost. */
export function costTier(m: ResolvedMember): string {
  const model = (m.model || m.connection.defaultModel || "").toLowerCase();
  const url = (m.connection.baseUrl ?? "").toLowerCase();
  if (/(-free|big-pickle|:free)$/.test(model) || /localhost|127\.0\.0\.1/.test(url)) return "free";
  if (CLI_KINDS.includes(m.connection.kind)) return "subscription (flat rate)";
  return "pay per token";
}

export function roster(builders: ResolvedMember[]): string {
  return builders
    .map((m) => {
      const model = m.model || m.connection.defaultModel || "default model";
      const agents = m.agents && m.agents > 1 ? `, ${m.agents} parallel agents` : "";
      const spec = m.instructions ? `; specialty: ${m.instructions.replace(/\s+/g, " ").slice(0, 240)}` : "";
      return `- id "${m.id}": ${m.name} (${m.connection.label}, ${model}; cost: ${costTier(m)}${agents}${spec})`;
    })
    .join("\n");
}

export function architectPrompt(request: string, tree: string, history: string[], crew = ""): string {
  return [
    history.length ? `Earlier requests in this project (oldest first):\n${history.map((h) => `- ${h}`).join("\n")}` : "",
    crew ? `Your crew of builders:\n${crew}` : "",
    `Current project files:\n${tree}`,
    `New request:\n${request}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function builderSystem(editsFiles: boolean, specialty?: string): string {
  const output = editsFiles
    ? `Edit the files in the current directory directly. Touch only the files your task owns unless strictly necessary.
When done, reply with a 1-3 sentence summary of what you changed.`
    : `Output format — STRICT:
For every file you create or change, output its COMPLETE new content:
<file path="relative/path.ext">
...full file content...
</file>
To delete a file: <delete path="relative/path.ext"/>
Outside these blocks write at most 3 short sentences. Never output partial files or diffs.`;
  return `${TEAM}
Your role: BUILDER. Implement exactly your assigned task, consistent with the plan and the other tasks' interfaces.${
    specialty ? `\nYour specialty and standing instructions from the user: ${specialty}` : ""
  }
${output}`;
}

export function builderPrompt(opts: {
  request: string;
  plan: Plan;
  task: PlanTask;
  tree: string;
  files: string;
}): string {
  const others = opts.plan.tasks
    .filter((t) => t.id !== opts.task.id)
    .map((t) => `- ${t.title} (owns: ${t.files.join(", ") || "—"})`)
    .join("\n");
  return [
    `User request:\n${opts.request}`,
    `Plan summary:\n${opts.plan.summary}`,
    others ? `Other tasks (handled by teammates, in parallel):\n${others}` : "",
    `YOUR TASK: ${opts.task.title}\nFiles you own: ${opts.task.files.join(", ") || "(decide)"}\n${opts.task.description}`,
    `Project files:\n${opts.tree}`,
    opts.files ? `Current contents:\n${opts.files}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reviewerSystem(): string {
  return `${TEAM}
Your role: REVIEWER. Check the result against the request: bugs, broken references between files
(ids, imports, function names), missing features, runtime errors, and obvious UX problems.
Ignore style nitpicks. Approve when it works and fulfils the request.
Reply with ONLY a JSON object:
{"approved": true|false, "summary": "<2-4 sentences>",
 "issues": [{"file": "path", "problem": "...", "fix": "<concrete instruction>"}]}`;
}

export function reviewerPrompt(request: string, plan: Plan, tree: string, files: string): string {
  return `User request:\n${request}\n\nPlan:\n${plan.summary}\n\nProject files:\n${tree}\n\nContents:\n${files}`;
}

export function fixTasks(issues: ReviewIssue[], round: number): PlanTask[] {
  const byFile = new Map<string, ReviewIssue[]>();
  for (const i of issues) {
    const key = i.file || "(general)";
    byFile.set(key, [...(byFile.get(key) ?? []), i]);
  }
  return [...byFile.entries()].slice(0, 8).map(([file, list], n) => ({
    id: `r${round}-${n + 1}`,
    title: `Fix ${file}`,
    description: list.map((i, k) => `${k + 1}. Problem: ${i.problem}\n   Fix: ${i.fix}`).join("\n"),
    files: file === "(general)" ? [] : [file],
  }));
}
