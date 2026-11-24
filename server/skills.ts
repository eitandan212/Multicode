import type { SkillMode } from "./shared.js";

/**
 * Built-in skill packs in the Agent Skills format (a folder with SKILL.md: YAML front matter
 * with name + description, then instructions). MultiCode decides which packs a request needs,
 * writes them into each harness's skills folder, and inlines them for API agents.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

export interface SkillPack {
  id: string;
  name: string;
  description: string;
  /** Always active in auto mode. */
  core?: boolean;
  /** Auto mode turns the pack on when the request matches one of these… */
  keywords?: RegExp;
  /** …or the project contains a matching file path. */
  files?: RegExp;
  skills: Skill[];
}

export const SKILL_PACKS: SkillPack[] = [
  {
    id: "quality",
    name: "Quality basics",
    description: "Self-review and secure coding. Always on in Auto.",
    core: true,
    skills: [
      {
        name: "self-review",
        description: "Checklist to run before reporting a task as done: requirements, wiring between files, errors, edge cases.",
        body: `# Self-review before you finish

Work through this list and fix what fails before you report back:

1. **Requirement coverage.** Re-read the request and your task. Every feature it names exists and is reachable from the UI or API.
2. **Wiring.** Every id, class, import, export and function name you reference exists with exactly that spelling in the file that defines it. Script and stylesheet paths resolve.
3. **Runtime errors.** No undefined variables, no calls on possibly-null values without a guard, no unhandled promise rejections.
4. **Edge cases.** Empty input, very long input, duplicate actions (double clicks), reload in the middle of a flow.
5. **No placeholders.** No "TODO", "lorem ipsum" or stub functions left in delivered code.
6. **Consistency.** Naming, formatting and patterns match the rest of the project.`,
      },
      {
        name: "secure-coding",
        description: "Rules that prevent the common vulnerabilities in generated code: injection, XSS, secrets, unsafe input handling.",
        body: `# Secure coding rules

- Never insert untrusted text with \`innerHTML\`, \`document.write\` or template strings into HTML. Use \`textContent\` or create elements.
- Validate and bound all external input (forms, URL params, storage, network) before use. Treat \`localStorage\` contents as untrusted: parse inside try/catch and validate the shape.
- Never hard-code secrets, tokens or passwords. Read them from configuration or environment variables.
- Build SQL, shell commands and file paths with parameterised APIs, never by string concatenation of user input.
- On servers, authorise every request on the server side; never trust a client-supplied role, price or id.
- Prefer allow-lists over block-lists.`,
      },
    ],
  },
  {
    id: "web",
    name: "Web craft",
    description: "Accessible, responsive, polished web UI.",
    keywords: /\b(web|site|page|landing|html|css|ui|frontend|front-end|react|vue|svelte|dashboard|form|button|app)\b/i,
    files: /\.(html|css|jsx|tsx|vue|svelte)$/i,
    skills: [
      {
        name: "frontend-quality",
        description: "Use when building or changing web UI: semantic HTML, accessibility, responsive layout, design tokens.",
        body: `# Frontend quality

**Structure.** Use semantic elements (\`header\`, \`main\`, \`nav\`, \`button\`, \`label\`). Every input has a label; every icon-only button has an \`aria-label\`.

**Layout.** Mobile first. Use flexbox/grid, \`min-width: 0\` on flex children that hold text, and test at 360px and 1440px. No horizontal scroll on phones.

**Design tokens.** Define colours, spacing, radius and fonts as CSS custom properties on \`:root\`, with a \`prefers-color-scheme: dark\` variant. Reuse tokens; don't hard-code one-off values.

**Interaction.** Visible \`:focus-visible\` styles, hover and active states, disabled states that explain why. Keyboard: Enter submits forms, Escape closes dialogs.

**Motion.** Short (150–300 ms), purposeful, and disabled under \`prefers-reduced-motion\`.

**Copy.** Sentence case. Buttons say what happens ("Save changes"). Empty and error states tell the user what to do next.`,
      },
      {
        name: "verify-in-browser",
        description: "Use after UI changes when a browser tool is available: load the preview, check the console, click the main flow.",
        body: `# Verify in the browser

If you have browser tools:
1. Open the project's preview URL from the shared instructions.
2. Read the console. Any error is a bug to fix.
3. Exercise the main flow end to end (create, edit, delete, reload).
4. Check one narrow viewport (about 375px wide).
Report what you verified in one or two sentences.`,
      },
    ],
  },
  {
    id: "testing",
    name: "Testing",
    description: "Write focused tests that prove behaviour.",
    keywords: /\b(test|tests|testing|spec|tdd|unit|e2e|coverage|bug|fix)\b/i,
    files: /(\.test\.|\.spec\.|__tests__|vitest|jest|pytest)/i,
    skills: [
      {
        name: "write-tests",
        description: "Use when adding features or fixing bugs: test the behaviour, cover edge cases, keep tests fast and deterministic.",
        body: `# Writing tests

- Test behaviour through the public interface, not private internals.
- One reason to fail per test; name it after the behaviour ("rejects an empty title").
- For every bug fix, first add a test that reproduces the bug.
- Cover the edges: empty, maximum size, invalid input, concurrency or double submission.
- No sleeps, no real network, no dependence on test order. Use fakes for time and I/O.
- Use the project's existing test runner and conventions; don't add a second framework.`,
      },
    ],
  },
  {
    id: "node",
    name: "Node & TypeScript",
    description: "Typed, robust server and tooling code.",
    keywords: /\b(node|typescript|ts|express|api|server|backend|cli|npm)\b/i,
    files: /(package\.json|tsconfig\.json|\.ts$)/i,
    skills: [
      {
        name: "typescript-practices",
        description: "Use when writing TypeScript or Node.js: strict types, error handling, async safety, small modules.",
        body: `# TypeScript and Node practices

- Keep \`strict\` on. No \`any\`; use \`unknown\` and narrow. Model data with types and discriminated unions.
- Validate data at the boundary (HTTP bodies, files, env) once, then trust the typed value inside.
- Every promise is awaited or explicitly handled. Wrap async route handlers so errors reach the error middleware.
- Return useful errors: status code + message for the caller, full detail in the server log.
- Small modules with one responsibility; no circular imports.
- Prefer the platform (fetch, node:fs/promises, AbortController) over extra dependencies.`,
      },
    ],
  },
  {
    id: "python",
    name: "Python",
    description: "Idiomatic, typed Python.",
    keywords: /\b(python|django|flask|fastapi|pandas|script|pip)\b/i,
    files: /(\.py$|requirements\.txt|pyproject\.toml)/i,
    skills: [
      {
        name: "python-practices",
        description: "Use when writing Python: type hints, standard library first, clear errors, tests with pytest.",
        body: `# Python practices

- Type-hint public functions; run the code mentally against \`mypy --strict\`.
- Prefer the standard library (pathlib, dataclasses, logging, argparse) before adding dependencies.
- Raise specific exceptions with actionable messages; never use a bare \`except:\`.
- Use context managers for files, locks and connections.
- Keep I/O at the edges and logic in pure functions so it is easy to test with pytest.`,
      },
    ],
  },
  {
    id: "roblox",
    name: "Roblox & Luau",
    description: "Server-authoritative, typed Roblox games.",
    keywords: /\b(roblox|luau|lua|rojo|game|obby|tycoon|simulator)\b/i,
    files: /(\.luau$|\.lua$|default\.project\.json|wally\.toml)/i,
    skills: [
      {
        name: "roblox-luau",
        description: "Use when writing Roblox Luau: server authority, RemoteEvent validation, strict typing, performance and mobile.",
        body: `# Roblox and Luau

**Authority.** The server owns game state. Clients send intents through RemoteEvents/RemoteFunctions; the server validates every argument (type, range, ownership, rate) and never trusts client-sent values for currency, damage or position.

**Typing.** \`--!strict\` at the top of every script. Type tables and remote payloads.

**Structure.** ModuleScripts in ReplicatedStorage (shared) and ServerScriptService (server-only). One responsibility per module.

**Data.** DataStore calls wrapped in pcall with retry and backoff; save on leave and on BindToClose; never write every frame.

**Performance.** No work in tight \`while true\` loops; use events and RunService wisely; clean up connections (Maid/Janitor pattern).

**UI and mobile.** Scale-based UI, touch-friendly targets (at least 44px), ContextActionService for cross-platform input.`,
      },
    ],
  },
];

export interface ActivePack {
  pack: SkillPack;
  reason: "core" | "request" | "project" | "on";
}

/** Which packs a request needs, given the user's per-pack modes. */
export function selectPacks(modes: Record<string, SkillMode>, request: string, files: string[]): ActivePack[] {
  const out: ActivePack[] = [];
  for (const pack of SKILL_PACKS) {
    const mode = modes[pack.id] ?? "auto";
    if (mode === "off") continue;
    if (mode === "on") out.push({ pack, reason: "on" });
    else if (pack.core) out.push({ pack, reason: "core" });
    else if (pack.keywords?.test(request)) out.push({ pack, reason: "request" });
    else if (pack.files && files.some((f) => pack.files!.test(f))) out.push({ pack, reason: "project" });
  }
  return out;
}

export function skillMarkdown(s: Skill): string {
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\nmetadata:\n  managed-by: multicode\n---\n\n${s.body.trim()}\n`;
}

/** Skills inlined into an API agent's prompt (those can't load skill folders). */
export function inlineSkills(packs: ActivePack[], maxChars = 6000): string {
  let out = "";
  for (const { pack } of packs)
    for (const s of pack.skills) {
      const block = `\n\n## Skill: ${s.name}\n${s.body.trim()}`;
      if (out.length + block.length > maxChars) return out;
      out += block;
    }
  return out;
}
