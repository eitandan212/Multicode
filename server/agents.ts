// Specialist agents: ready-made roles you add to the crew on any model. The model keeps its
// own name; the specialty shows as a tag and steers the planner, the manager and the agent.
import type { Role } from "./shared.js";

export interface AgentPreset {
  id: string;
  title: string;
  role: Role;
  /** Icon name from the UI's icon set. */
  icon: string;
  /** One line for the gallery. */
  description: string;
  /** Standing instructions given to the agent (and its specialty for the manager). */
  instructions: string;
  /** Prefer a frontier model for this agent when one is connected. */
  strong?: boolean;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "planner",
    title: "Lead planner",
    role: "architect",
    icon: "spark",
    description:
      "Thinks the request through and splits it into clear, parallel tasks.",
    instructions:
      "Lead planner. Think through edge cases, data flow and file boundaries before splitting the work; define the shared interfaces (ids, function names, data shapes) every task relies on.",
    strong: true,
  },
  {
    id: "frontend",
    title: "Frontend engineer",
    role: "builder",
    icon: "globe",
    description:
      "UI, HTML/CSS/JS and React, responsive layouts and accessibility.",
    instructions:
      "Frontend engineer: semantic HTML, modern CSS (grid/flex, custom properties), responsive down to phone width, keyboard and screen-reader accessible, smooth but restrained motion.",
  },
  {
    id: "backend",
    title: "Backend engineer",
    role: "builder",
    icon: "terminal",
    description: "APIs, data models, servers, validation and error handling.",
    instructions:
      "Backend engineer: clean APIs, validated input, explicit error handling, safe data access (no injection), sensible status codes, no secrets in code.",
  },
  {
    id: "designer",
    title: "UI designer",
    role: "builder",
    icon: "palette",
    description:
      "Visual polish: typography, spacing, colour, motion and dark mode.",
    instructions:
      "UI designer: consistent spacing scale, clear typographic hierarchy, accessible contrast, light and dark themes, polished hover/focus states and purposeful animation.",
  },
  {
    id: "tester",
    title: "Test engineer",
    role: "builder",
    icon: "check",
    description: "Writes automated tests for the features being built.",
    instructions:
      "Test engineer: write focused automated tests for the behaviour in the plan (happy path, edge cases, failure cases) using the project's test setup, or a minimal one if there is none.",
  },
  {
    id: "debugger",
    title: "Debugger",
    role: "builder",
    icon: "search",
    description: "Finds root causes and fixes bugs without collateral changes.",
    instructions:
      "Debugger: reproduce the problem from the code, find the root cause before changing anything, fix it minimally, and don't refactor unrelated code.",
    strong: true,
  },
  {
    id: "docs",
    title: "Docs writer",
    role: "builder",
    icon: "file",
    description: "READMEs, usage guides and clear code comments.",
    instructions:
      "Docs writer: concise README (what it is, how to run it, how to use it), accurate to the code; comment only non-obvious decisions.",
  },
  {
    id: "roblox",
    title: "Roblox / Luau engineer",
    role: "builder",
    icon: "spark",
    description:
      "Luau scripts, server-authoritative multiplayer, DataStores and UI.",
    instructions:
      "Roblox engineer: strict-typed Luau, server-authoritative logic, validate every RemoteEvent on the server, safe DataStore access with retries, mobile-friendly UI, no memory leaks (disconnect connections).",
  },
  {
    id: "reviewer",
    title: "Code reviewer",
    role: "reviewer",
    icon: "users",
    description: "Checks correctness, missing features and broken references.",
    instructions:
      "Code reviewer: correctness, missing features, broken references between files and runtime errors.",
    strong: true,
  },
  {
    id: "security",
    title: "Security reviewer",
    role: "reviewer",
    icon: "shield",
    description:
      "Looks for injection, XSS, unsafe input handling and leaked secrets.",
    instructions:
      "Security reviewer: report only real security problems: injection, XSS, unsafe eval, missing input validation or authorization checks, secrets in code, insecure defaults. Approve when none remain.",
    strong: true,
  },
  {
    id: "performance",
    title: "Performance reviewer",
    role: "reviewer",
    icon: "spark",
    description:
      "Spots slow loops, layout thrash, heavy assets and memory leaks.",
    instructions:
      "Performance reviewer: report only meaningful performance problems: needless work in loops or renders, layout thrashing, unbounded growth, heavy assets, leaks. Approve when none remain.",
  },
  {
    id: "a11y",
    title: "Accessibility reviewer",
    role: "reviewer",
    icon: "eye",
    description: "Keyboard use, screen readers, contrast and focus order.",
    instructions:
      "Accessibility reviewer: report keyboard traps, missing labels or alt text, low contrast, broken focus order and missing ARIA where needed. Approve when none remain.",
  },
];

export const PRESET_IDS = new Set(AGENT_PRESETS.map((p) => p.id));
