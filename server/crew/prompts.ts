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

/**
 * Sleep mode: the user is away until morning, so nobody answers questions or approvals. Added
 * last, so it wins over "ask when the request is vague".
 */
export const AWAY = `

SLEEP MODE: the user is asleep and will read the result in the morning. Nobody can answer you.
Never ask a question and never stop to wait for confirmation: when something is unclear, choose the
most reasonable interpretation, build it fully, and list your assumptions in your summary.
Architect: always plan concrete tasks (never answer with a question instead of a plan).`;

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
Your role: ARCHITECT. Read the message and decide, with your own judgement, what it needs:
- an answer (a greeting, a question, a discussion): answer it yourself, briefly and naturally;
- questions: when building it would mean guessing something that matters (what exactly to make, for
  whom, which platform or stack, the main features, the look), ask first. Ask only what you truly need
  (1-3 questions), each with a few likely answers the user can pick. A clear, small change needs no
  questions; a new app or a big feature described in a few words usually does;
- a plan: when you know what to build, split it into 1-6 tasks for builders working in parallel.
Plan from the file list you're given; open a file only when the plan depends on it (3 at most).
Each task owns its own files (no file in two tasks), is self-sufficient, and states the interfaces
others rely on. A small change is one task. Answer in the user's language.${assign}
Reply with ONLY one JSON object, one of:
{"reply": "<your answer>", "tasks": []}
{"questions": [{"question": "...", "options": ["...", "..."]}], "tasks": []}
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
  mentions = "",
): string {
  return [
    history.length
      ? `Conversation so far (oldest first; the new request may refer to it):\n${history.map((h) => `---\n${h}`).join("\n")}`
      : "",
    crew ? `Your crew of builders:\n${crew}` : "",
    `Current project files:\n${tree}`,
    mentions ? `Files the request mentions with @:\n${mentions}` : "",
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

/** How the crew talks while it builds together (added to builders' and partners' instructions). */
export const TEAM_CHAT = `You build TOGETHER with your teammates, at the same time, in the same project folder.
Their latest messages and what each is working on right now are below: respect what they agreed
and don't redo or undo their work. To tell the team something they need (an interface or name you
defined, a change to a shared file, a problem you found in their part), write it on its own line as
<team>one or two short sentences</team>. Only what helps them; no greetings.`;

/** A teammate edits the code the driver just wrote: pair programming, both hands on the code. */
export function pairSystem(editsFiles: boolean, specialty?: string): string {
  return `${builderSystem(editsFiles, specialty)}

You are PAIR PROGRAMMING: your teammate just wrote the change below for this task. Work on the same
code with your own hands: fix bugs, finish anything missing or half-done, tighten weak spots, and
make it fit the rest of the project. Keep what is already good: improve it, don't rewrite it for
taste. If the work is right as it is, change no files and say so in <team>…</team>.
${TEAM_CHAT}`;
}

export function pairPrompt(opts: {
  request: string;
  task: PlanTask;
  /** Who wrote the change you now work on. */
  from: string;
  /** "partner": you continue the driver's work. "reply": the partner changed your work. */
  turn: "partner" | "reply";
  diff: string;
  tree: string;
  files: string;
  team: string;
}): string {
  return [
    `User request:\n${opts.request}`,
    `TASK: ${opts.task.title}\nFiles: ${opts.task.files.join(", ") || "(see the change)"}\n${opts.task.description}`,
    opts.turn === "partner"
      ? `${opts.from} just wrote this for the task (your turn at the keyboard):\n${opts.diff || "(no file changes)"}`
      : `Your pair partner ${opts.from} edited your work like this:\n${opts.diff}\n\nKeep what improves it and fix anything it broke. If it's all good, change nothing and reply in <team>…</team>.`,
    opts.team ? `Team chat and who is working on what:\n${opts.team}` : "",
    `Project files:\n${opts.tree}`,
    opts.files ? `Current contents:\n${opts.files}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function builderPrompt(opts: {
  request: string;
  plan: Plan;
  task: PlanTask;
  tree: string;
  files: string;
  /** The team chat and who is working on what right now (together mode). */
  team?: string;
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
    opts.team ? `Team chat and who is working on what right now:\n${opts.team}` : "",
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

// ---- Compare: several models do the same task; the reviewer picks the best ----

export function competitorSystem(editsFiles: boolean, specialty?: string): string {
  return `${builderSystem(editsFiles, specialty)}

Several models are doing this same task at the same time, each in its own copy of the project, and
the best version is kept. Do the whole task yourself, completely and correctly; quality wins, not
speed. Don't leave TODOs.`;
}

export function competitorPrompt(request: string, tree: string, files: string): string {
  return [
    `Task:\n${request}`,
    `Project files:\n${tree}`,
    files ? `Current contents:\n${files}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const JUDGE_SYSTEM = `You are the REVIEWER comparing several versions of the same task, each made by a different model.
Judge correctness first, then completeness, then code quality and simplicity. Answer with JSON only:
{"best": "<version id>", "why": "<two or three sentences: why it wins, and the main weakness of the others>"}`;

export function judgePrompt(request: string, versions: { id: string; by: string; files: string }[]): string {
  return [
    `Task:\n${request}`,
    ...versions.map((v) => `=== Version ${v.id} (by ${v.by}) ===\n${v.files || "(no changes)"}`),
  ].join("\n\n");
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
