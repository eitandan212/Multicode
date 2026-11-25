// Claude Code through the Claude Agent SDK (as T3 Code does) instead of parsing `claude -p`.
// The SDK runs the user's own installed `claude` (their subscription sign-in), streams typed
// messages, reports usage and cost, and asks MultiCode before every tool call it would otherwise
// prompt for, so MultiCode's policy is enforced in code rather than by CLI flags alone.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Connection } from "../config.js";
import type { McpServer } from "../shared.js";
import { findBinary, resolveLaunch } from "./cli.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

/** Tools that only look: always fine. */
const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "Task",
  "ExitPlanMode",
  "BashOutput",
]);
/** Tools that change files: edit tasks only, inside the project only. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** MultiCode's decision for one Claude Code tool call (shell and web access are refused). */
export function claudeToolDecision(
  tool: string,
  input: Record<string, unknown>,
  mode: GenerateRequest["mode"],
  cwd: string,
): { allow: true } | { allow: false; message: string } {
  if (READ_TOOLS.has(tool)) return { allow: true };
  // Plugins the user turned on in MultiCode (memory graph, browser, desktop...) are MCP tools.
  if (tool.startsWith("mcp__")) return { allow: true };
  if (EDIT_TOOLS.has(tool)) {
    if (mode !== "edit")
      return { allow: false, message: "This task is read-only." };
    const target = String(input.file_path ?? input.notebook_path ?? "");
    const rel = path.relative(path.resolve(cwd), path.resolve(cwd, target));
    if (!target || rel.startsWith("..") || path.isAbsolute(rel))
      return {
        allow: false,
        message: `MultiCode only lets agents change files inside the project (${target || "no path"}).`,
      };
    return { allow: true };
  }
  return {
    allow: false,
    message: `MultiCode doesn't let agents use ${tool} here; read and edit files instead.`,
  };
}

/** MultiCode's shared MCP servers in the SDK's shape. */
export function claudeMcpServers(
  servers: McpServer[],
  env: Record<string, string>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    if (s.type === "stdio" && s.command) {
      const vars: Record<string, string> = { ...(s.fixedEnv ?? {}) };
      for (const n of s.envNames ?? [])
        if (env[n] !== undefined) vars[n] = env[n]!;
      out[s.name] = {
        type: "stdio",
        command: s.command,
        args: s.args ?? [],
        env: vars,
      };
    } else if (s.type === "http" && s.url)
      out[s.name] = { type: "http", url: s.url };
  }
  return out;
}

/** A short label for a tool call in the live view. */
function toolLabel(name: string, input: Record<string, unknown>): string {
  const target =
    input.file_path ??
    input.path ??
    input.pattern ??
    input.command ??
    input.url;
  return target ? `${name} ${String(target).slice(0, 140)}` : name;
}

type Query = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export class ClaudeSdkProvider implements Provider {
  readonly editsFiles = true;

  constructor(
    private conn: Connection,
    private run: Query = query as unknown as Query,
    private executable: () => Promise<
      Pick<Options, "pathToClaudeCodeExecutable" | "executable">
    > = installedClaude,
  ) {}

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    await mkdir(req.cwd, { recursive: true });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const blocked: string[] = [];
    const canUseTool: CanUseTool = async (tool, input) => {
      const d = claudeToolDecision(tool, input, req.mode, req.cwd);
      if (d.allow) return { behavior: "allow", updatedInput: input };
      blocked.push(tool);
      onDelta(`▸ Blocked by MultiCode: ${toolLabel(tool, input)}\n`);
      return { behavior: "deny", message: d.message };
    };
    const model = req.model || this.conn.defaultModel;
    let answer = "";
    let lastWasTool = false;
    try {
      for await (const msg of this.run({
        prompt: req.prompt,
        options: {
          ...(await this.executable()),
          cwd: req.cwd,
          ...(model ? { model } : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: req.system,
          },
          permissionMode: req.mode === "edit" ? "acceptEdits" : "plan",
          canUseTool,
          mcpServers: claudeMcpServers(req.mcpServers ?? [], req.env ?? {}),
          includePartialMessages: true,
          persistSession: false,
          env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
          abortController,
        },
      })) {
        switch (msg.type) {
          case "stream_event": {
            const e = msg.event;
            if (
              msg.parent_tool_use_id === null &&
              e.type === "content_block_delta" &&
              e.delta.type === "text_delta"
            ) {
              if (lastWasTool && !answer.endsWith("\n")) onDelta("\n");
              lastWasTool = false;
              answer += e.delta.text;
              onDelta(e.delta.text);
            }
            break;
          }
          case "assistant": {
            if (
              msg.error === "authentication_failed" ||
              msg.error === "oauth_org_not_allowed"
            )
              throw new ProviderError(
                "Claude Code isn't signed in. Run `claude` in a terminal once and log in, then try again.",
              );
            if (msg.error === "rate_limit")
              throw new ProviderError(
                "Claude usage limit reached (rate limit).",
              );
            for (const block of msg.message.content)
              if (block.type === "tool_use") {
                onDelta(
                  `${answer && !lastWasTool ? "\n" : ""}▸ ${toolLabel(block.name, (block.input ?? {}) as Record<string, unknown>)}\n`,
                );
                lastWasTool = true;
              }
            break;
          }
          case "result": {
            req.onUsage?.({
              input: msg.usage.input_tokens,
              output: msg.usage.output_tokens,
              costUsd: msg.total_cost_usd,
            });
            if (msg.subtype !== "success")
              throw new ProviderError(
                `Claude Code stopped: ${msg.subtype.replace(/_/g, " ")}`,
              );
            if (msg.is_error)
              throw new ProviderError(
                msg.result || "Claude Code reported an error",
              );
            return (answer.trim() || msg.result || "").trim();
          }
        }
      }
      if (signal.aborted) throw new ProviderError("Cancelled");
      return answer.trim();
    } catch (err) {
      if (signal.aborted) throw new ProviderError("Cancelled");
      throw err instanceof ProviderError
        ? err
        : new ProviderError((err as Error).message);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The user's own `claude` (signed in to their subscription). The SDK's bundled native binaries
 * aren't shipped with MultiCode: an installer built on one OS would carry the wrong one.
 */
async function installedClaude(): Promise<
  Pick<Options, "pathToClaudeCodeExecutable" | "executable">
> {
  const bin = await findBinary("claude");
  if (!bin)
    throw new ProviderError(
      '"claude" not found. Install: npm i -g @anthropic-ai/claude-code, then run `claude` once and sign in',
    );
  const l = await resolveLaunch(bin);
  // npm on Windows installs a .cmd shim: hand the SDK the script behind it, run with node.
  if (l.prefix.length && /\.(c?js|mjs)$/i.test(l.prefix[0]!))
    return { pathToClaudeCodeExecutable: l.prefix[0]!, executable: "node" };
  return { pathToClaudeCodeExecutable: l.command };
}
