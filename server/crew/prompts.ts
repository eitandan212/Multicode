import type { ResolvedMember } from "./orchestrator.js";
import {
  AGENT_KINDS,
  type Plan,
  type PlanTask,
  type ReviewIssue,
} from "../shared.js";
import { modelStrength } from "../team.js";
import { isFreeEndpoint } from "../shared.js";

const TEAM = `You are part of MultiCode, a crew of AI engineers from different vendors building one project together.
Write production-quality, complete code — never placeholders or "TODO: implement".
Build only what the user asked for, in the form they asked for: never turn a message into a website or
an app they didn't request. Follow the existing project's language and stack. Only when the user asks
for something visual or interactive and names no platform, and the project is empty, use a
self-contained web page (index.html + CSS + JS, no build step).`;

export function architectSystem(dispatch = false, economy = false): string {
  const assign = dispatch
    ? `
You are also the DISPATCHER. For every task pick the crew member that fits best:
- match the task to each member's specialty and model strength;
- cost matters: give simple or mechanical work to free or subscription members, and keep
  pay-per-token members for the hardest work;
- spread the work so members run in parallel (a member with N agents can take N tasks at once).
Add "assignee" (the member id) and "why" (under 12 words) to every task.${
        economy
          ? "\nECONOMY MODE: the user is saving tokens. Give every task you reasonably can to free members, use as few tasks as possible, and use pay-per-token members only when a task clearly needs them."
          : ""
      }`
    : economy
      ? "\nECONOMY MODE: use as few tasks as possible."
      : "";
  return `${TEAM}
Your role: ARCHITECT. You do not write code. You split the request into 1-6 tasks for parallel builders.
Plan from the file list you are given. Every step you take costs the user money: open a file only when
the plan truly depends on its contents, and never read more than 3.
Rules:
- Each task owns a disjoint set of files (two tasks must never list the same file).
- Order does not matter; tasks run in parallel, so make each self-sufficient and state the interfaces
  (element ids, function names, data shapes) other tasks rely on.
- Small requests deserve ONE task. Do not over-split.
- If the message does not ask to build or change anything (a greeting, thanks, small talk, or a
  question you can answer from the file list), do NOT invent work: answer it yourself in 1-3
  sentences with {"reply": "<your answer>", "tasks": []}.
- If the request is too vague to build (it doesn't say what to make), do NOT guess and do NOT default
  to a website: ask what they want with {"reply": "<one short question>", "tasks": []}.
- Reply in the user's language.${assign}
Reply with ONLY a JSON object:
{"summary": "<one paragraph: approach and shared conventions>",
 "tasks": [{"title": "...", "description": "<precise instructions incl. interfaces>", "files": ["relative/path.ext"]${dispatch ? ', "assignee": "<member id>", "why": "..."' : ""}}]}`;
}

/** How a member is billed, so the dispatcher can weigh cost. */
export function costTier(m: ResolvedMember): string {
  const model = (m.model || m.connection.defaultModel || "").toLowerCase();
  const url = (m.connection.baseUrl ?? "").toLowerCase();
  if (/(-free|big-pickle|:free)$/.test(model) || isFreeEndpoint(url))
    return "free";
  if (AGENT_KINDS.includes(m.connection.kind))
    return "subscription (flat rate)";
  return "pay per token";
}

export function roster(builders: ResolvedMember[]): string {
  return builders
    .map((m) => {
      const model = m.model || m.connection.defaultModel || "default model";
      const agents =
        m.agents && m.agents > 1 ? `, ${m.agents} parallel agents` : "";
      const spec = m.instructions
        ? `; specialty: ${m.instructions.replace(/\s+/g, " ").slice(0, 240)}`
        : "";
      return `- id "${m.id}": ${m.name} (${m.connection.label}, ${model}; cost: ${costTier(m)}${agents}${spec})`;
    })
    .join("\n");
}

export function architectPrompt(
  request: string,
  tree: string,
  history: string[],
  crew = "",
): string {
  return [
    history.length
      ? `Earlier requests in this project (oldest first):\n${history.map((h) => `- ${h}`).join("\n")}`
      : "",
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
    specialty
      ? `\nYour specialty and standing instructions from the user: ${specialty}`
      : ""
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

export function reviewerSystem(specialty?: string): string {
  const focus = specialty?.trim()
    ? `\nYour specialty (focus your review on it): ${specialty.trim().slice(0, 600)}`
    : "";
  return `${TEAM}
Your role: REVIEWER. Check the result against the request: bugs, broken references between files
(ids, imports, function names), missing features, runtime errors, and obvious UX problems.
Ignore style nitpicks. Approve when it works and fulfils the request.${focus}
Reply with ONLY a JSON object:
{"approved": true|false, "summary": "<2-4 sentences>",
 "issues": [{"file": "path", "problem": "...", "fix": "<concrete instruction>"}]}`;
}

export function reviewerPrompt(
  request: string,
  plan: Plan,
  tree: string,
  files: string,
): string {
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
    description: list
      .map((i, k) => `${k + 1}. Problem: ${i.problem}\n   Fix: ${i.fix}`)
      .join("\n"),
    files: file === "(general)" ? [] : [file],
  }));
}

export function designerSystem(
  editsFiles: boolean,
  specialty?: string,
): string {
  return `${builderSystem(editsFiles, specialty)}

You are a DESIGNER in a design competition: several models each design their own version and the
user picks one. Make yours distinctive, polished and complete. Keep every feature working; the
difference between versions is the visual design, layout, typography, colour and motion.`;
}

export function designerPrompt(
  request: string,
  direction: string,
  tree: string,
  files: string,
): string {
  return [
    `Design request:\n${request}`,
    `YOUR DIRECTION: ${direction}`,
    "Deliver a complete, working result (at least index.html) that a user can open and use.",
    `Project files:\n${tree}`,
    files ? `Current contents:\n${files}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---- Manager: a free or cheap model that staffs the work and routes tasks ----

const STRENGTH_LABEL = ["", "light", "strong", "frontier"];

/** Candidates for the manager, with strength and cost, so it can staff sensibly. */
export function candidates(members: ResolvedMember[]): string {
  return members
    .map((m) => {
      const model = m.model || m.connection.defaultModel || "";
      const tier =
        STRENGTH_LABEL[modelStrength(m.connection.kind, model)] ?? "strong";
      const spec = m.instructions
        ? `; specialty: ${m.instructions.replace(/\s+/g, " ").slice(0, 160)}`
        : "";
      return `- id "${m.id}": ${m.name} (${m.connection.label}, ${model || "default model"}; strength: ${tier}; cost: ${costTier(m)}${spec})`;
    })
    .join("\n");
}

export function managerTeamSystem(economy = false): string {
  return `${TEAM}
Your role: MANAGER. You do not plan or write code; you choose who does, from the candidates.
- ARCHITECT thinks the request through and plans it: pick the strongest reasoning model.
- REVIEWER checks the result: pick a strong model, ideally from a different vendor than the architect.
- BUILDERS write the code: include models that fit the work. Simple or mechanical work suits free
  and subscription models; keep pay-per-token frontier models for the hard parts. A small request
  needs only one or two builders.${economy ? "\nECONOMY MODE: prefer free and subscription models wherever they can do the job." : ""}
Reply with ONLY a JSON object:
{"architect": "<id>", "reviewer": "<id>", "builders": ["<id>", ...], "why": "<one short sentence>"}`;
}

export function managerTeamPrompt(
  request: string,
  pool: ResolvedMember[],
): string {
  return `The request:\n${request}\n\nCandidates:\n${candidates(pool)}`;
}

export function managerDispatchSystem(economy = false): string {
  return `${TEAM}
Your role: MANAGER. The architect has planned the work. Assign every task to the builder that fits
best: match the task to each builder's strength and specialty; give simple work to free or
subscription builders and keep pay-per-token ones for the hardest tasks; spread tasks so builders
work in parallel (a builder with N agents can take N tasks at once).${
    economy
      ? "\nECONOMY MODE: give every task you reasonably can to free builders."
      : ""
  }
Reply with ONLY a JSON object:
{"assignments": [{"task": "<task id>", "assignee": "<builder id>", "why": "<under 12 words>"}]}`;
}

export function managerDispatchPrompt(
  plan: Plan,
  builders: ResolvedMember[],
): string {
  const tasks = plan.tasks
    .map(
      (t) =>
        `- ${t.id}: ${t.title}${t.files.length ? ` [files: ${t.files.join(", ")}]` : ""}\n  ${t.description.replace(/\s+/g, " ").slice(0, 400)}`,
    )
    .join("\n");
  return `Tasks:\n${tasks}\n\nBuilders:\n${candidates(builders)}`;
}
