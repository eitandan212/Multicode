import path from "node:path";
import type { McpServer, PluginInfo } from "./shared.js";

/**
 * Plugins are curated MCP servers that MultiCode wires into every harness automatically.
 * Versions are pinned so a run never pulls an unreviewed release.
 */
export interface PluginDef extends Omit<PluginInfo, "enabled" | "envSet"> {
  defaultOn: boolean;
  server(ctx: PluginContext): McpServer;
  /** Guidance added to the shared instructions while the plugin is on. */
  instructions?: string | ((ctx: PluginContext) => string);
}

export interface PluginContext {
  project: string;
  /** MultiCode's data folder (absolute). */
  dataDir: string;
  /** Origin the preview is served from, e.g. http://localhost:4317. */
  previewOrigin: string;
  options: { browserAnyWebsite?: boolean };
}

export const memoryGraphFile = (dataDir: string, project: string) => path.join(dataDir, "graphs", `${project}.jsonl`);

export const PLUGINS: PluginDef[] = [
  {
    id: "memory-graph",
    name: "Memory graph",
    category: "memory",
    description:
      "A shared knowledge graph of the project: decisions, files and what each agent learned. Every harness reads and writes the same graph, and MultiCode records each finished thread in it.",
    risk: "low",
    defaultOn: true,
    source: "@modelcontextprotocol/server-memory@2.2.1",
    server: (c) => ({
      name: "memory",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory@2.2.1"],
      envNames: ["MEMORY_FILE_PATH"],
      fixedEnv: { MEMORY_FILE_PATH: memoryGraphFile(c.dataDir, c.project) },
    }),
    instructions:
      "Memory graph: before you start, call `search_nodes` (or `read_graph` on small projects) to recall earlier decisions. When you make a decision others must respect (a naming convention, an API shape, a library choice), record it with `create_entities` / `add_observations`.",
  },
  {
    id: "browser",
    name: "AI browser (Playwright)",
    category: "browser",
    description:
      "A real browser agents can drive: open the live preview, click through the app, read the console and take snapshots. Limited to the MultiCode preview unless you allow any website.",
    risk: "medium",
    defaultOn: true,
    source: "@playwright/mcp@0.0.86 (Microsoft)",
    server: (c) => ({
      name: "browser",
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@0.0.86",
        "--headless",
        "--isolated",
        ...(c.options.browserAnyWebsite ? [] : ["--allowed-origins", `${c.previewOrigin};${c.previewOrigin.replace("localhost", "127.0.0.1")}`]),
      ],
    }),
    instructions: (c) =>
      `Browser: after you change the UI, open ${c.previewOrigin}/preview/${c.project}/ with the browser tools, check the console for errors and click through the main flow before you call the work done.`,
  },
  {
    id: "devtools",
    name: "Chrome DevTools",
    category: "browser",
    description: "Performance traces, network requests and console logs from Chrome, for debugging what the browser shows.",
    risk: "medium",
    defaultOn: false,
    source: "chrome-devtools-mcp@1.14.0 (Google)",
    server: () => ({ name: "chrome-devtools", type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@1.14.0", "--headless", "--isolated"] }),
  },
  {
    id: "context7",
    name: "Live library docs (Context7)",
    category: "knowledge",
    description: "Up-to-date documentation and code examples for thousands of libraries, so agents don't code against stale APIs.",
    risk: "low",
    defaultOn: false,
    source: "@upstash/context7-mcp@4.8.0",
    optionalEnv: ["CONTEXT7_API_KEY"],
    server: () => ({ name: "context7", type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@4.8.0"], envNames: ["CONTEXT7_API_KEY"] }),
    instructions: "Library docs: when you use a third-party library, check its current API with the Context7 tools first.",
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    category: "reasoning",
    description: "A scratchpad tool for breaking hard problems into revisable steps. Helps smaller models plan.",
    risk: "low",
    defaultOn: false,
    source: "@modelcontextprotocol/server-sequential-thinking@2.2.0",
    server: () => ({
      name: "sequential-thinking",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.2.0"],
    }),
  },
  {
    id: "computer-use",
    name: "Computer control",
    category: "computer",
    description:
      "Lets agents see your screen and move the mouse and keyboard. Useful for testing desktop apps or games, but an agent can then do anything you can do on this computer.",
    risk: "high",
    defaultOn: false,
    source: "computer-use-mcp@2.0.0",
    server: () => ({ name: "computer", type: "stdio", command: "npx", args: ["-y", "computer-use-mcp@2.0.0"] }),
  },
  {
    id: "desktop-commander",
    name: "Desktop Commander",
    category: "computer",
    description:
      "Terminal commands, processes and files anywhere on this computer, outside the project folder. It bypasses the edit-only limits MultiCode puts on agents.",
    risk: "high",
    defaultOn: false,
    source: "@wonderwhy-er/desktop-commander@0.3.4",
    server: () => ({ name: "desktop-commander", type: "stdio", command: "npx", args: ["-y", "@wonderwhy-er/desktop-commander@0.3.4"] }),
  },
];

export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id);

export function enabledPlugins(state: { enabled?: string[]; disabled?: string[] }): PluginDef[] {
  return PLUGINS.filter((p) => (p.defaultOn ? !state.disabled?.includes(p.id) : state.enabled?.includes(p.id)));
}

/** MCP servers and extra instructions contributed by the enabled plugins. */
export function pluginContributions(state: { enabled?: string[]; disabled?: string[] }, ctx: PluginContext) {
  const on = enabledPlugins(state);
  return {
    servers: on.map((p) => p.server(ctx)),
    instructions: on.map((p) => (typeof p.instructions === "function" ? p.instructions(ctx) : p.instructions)).filter((t): t is string => Boolean(t)),
  };
}
