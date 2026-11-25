// Agent Client Protocol agents, through T3 Code's own client: `effect-acp` (vendored from T3 Code,
// MIT, under server/vendor/t3code) speaks ACP with its generated schemas, launched the same way
// T3 Code launches agents. Any ACP agent (Claude Code, Codex, Gemini CLI, Copilot, Cursor, Goose,
// Kiro, Qoder...) can join a crew through it. MultiCode stays the client: it answers the agent's
// file reads and writes itself, inside the project only, and grants tool permissions by
// MultiCode's own policy.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Connection } from "../config.js";
import { loadRegistry, resolveAgent, type AcpLaunch } from "../acp/registry.js";
import type { McpServer } from "../shared.js";
import { findBinary, resolveLaunch } from "./cli.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AcpClient from "../vendor/t3code/effect-acp/client.ts";
import * as AcpError from "../vendor/t3code/effect-acp/errors.ts";
import { openSession, run } from "./t3bridge.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const ACP_PROTOCOL_VERSION = 1;
const MAX_READ = 2_000_000;

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/**
 * MultiCode's permission policy for ACP tool calls, matching the CLI agents' edit-only mode:
 * reading and thinking are always fine, file changes only when the task may edit, and shell
 * commands, web fetches and unknown tools are refused.
 */
export function allowTool(
  kind: ToolKind | undefined,
  mode: GenerateRequest["mode"],
): boolean {
  const k = kind ?? "other";
  if (k === "read" || k === "search" || k === "think") return true;
  if (mode === "edit" && (k === "edit" || k === "move" || k === "delete"))
    return true;
  return false;
}

/** Resolves `p` inside `root`, or throws: agents may only touch files of the project. */
export function insideRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`path is outside the project: ${p}`);
  return abs;
}

/** MultiCode's shared MCP servers in ACP's shape (stdio always; http when the agent supports it). */
export async function acpMcpServers(
  servers: McpServer[],
  env: Record<string, string>,
  http: boolean,
): Promise<Json[]> {
  const out: Json[] = [];
  for (const s of servers) {
    if (s.type === "stdio" && s.command) {
      const vars = [
        ...Object.entries(s.fixedEnv ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
        ...(s.envNames ?? [])
          .filter((n) => env[n] !== undefined)
          .map((name) => ({ name, value: env[name]! })),
      ];
      // ACP wants an absolute command path.
      const command = path.isAbsolute(s.command)
        ? s.command
        : ((await findBinary(s.command)) ?? s.command);
      out.push({ name: s.name, command, args: s.args ?? [], env: vars });
    } else if (s.type === "http" && s.url && http) {
      out.push({ type: "http", name: s.name, url: s.url, headers: [] });
    }
  }
  return out;
}

interface InitResult {
  protocolVersion?: number;
  agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
  authMethods?: { id: string; name: string; description?: string }[];
  agentInfo?: { name?: string; title?: string };
}
interface ConfigOption {
  id: string;
  category?: string | null;
  type?: string;
  currentValue?: unknown;
  options?: (
    | { value: string; name: string }
    | { group: string; options: { value: string; name: string }[] }
  )[];
}
interface NewSessionResult {
  sessionId: string;
  configOptions?: ConfigOption[] | null;
  models?: {
    currentModelId?: string;
    availableModels?: { modelId: string; name?: string }[];
  } | null;
}

function modelChoices(s: NewSessionResult): {
  configId?: string;
  values: string[];
} {
  const opt = s.configOptions?.find(
    (o) => o.category === "model" && (o.type ?? "select") === "select",
  );
  if (opt?.options) {
    const values = opt.options.flatMap((o) =>
      "group" in o ? o.options.map((x) => x.value) : [o.value],
    );
    return { configId: opt.id, values };
  }
  return { values: s.models?.availableModels?.map((m) => m.modelId) ?? [] };
}

export class AcpProvider implements Provider {
  readonly editsFiles = true;

  constructor(
    private conn: Connection,
    private resolveLaunch: (
      conn: Connection,
    ) => Promise<AcpLaunch> = launchForConnection,
  ) {}

  private get agentName(): string {
    return this.conn.acp?.agentName ?? this.conn.label;
  }

  /** Starts the agent with T3 Code's ACP client and MultiCode's handlers for its requests. */
  private async open(
    cwd: string,
    req: Pick<GenerateRequest, "env" | "mode" | "cwd">,
    onDelta: DeltaHandler,
    tools: { blocked: string[] },
    onUpdate: (update: Record<string, unknown>) => void = () => {},
  ) {
    const launch = await platformLaunch(await this.resolveLaunch(this.conn));
    // spawn reports a missing working folder as ENOENT on the command; make sure it exists.
    await mkdir(cwd, { recursive: true });
    const root = path.resolve(req.cwd);
    const ended = await Effect.runPromise(Deferred.make<string>());
    const fail = (err: unknown) =>
      AcpError.AcpRequestError.invalidParams((err as Error).message ?? String(err));
    const session = await openSession(launch, cwd, req.env ?? {}, (child) =>
      Effect.gen(function* () {
        // As T3 Code does, the agent's stderr is read on the side (the protocol client ignores it):
        // its last lines explain an agent that dies.
        let stderrTail = "";
        yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((t) =>
            Effect.sync(() => {
              stderrTail = (stderrTail + t).slice(-2000);
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        const context = yield* Layer.build(
          AcpClient.layerChildProcess(child, {
            transformStdout: jsonLinesOnly,
            onTermination: (e) =>
              Effect.sleep("50 millis").pipe(
                Effect.andThen(
                  Deferred.succeed(
                    ended,
                    [e.message, stderrTail.trim()].filter(Boolean).join(": "),
                  ),
                ),
                Effect.asVoid,
              ),
          }),
        );
        const client = yield* Effect.service(AcpClient.AcpClient).pipe(
          Effect.provide(context),
        );
        yield* client.handleRequestPermission((params) =>
          Effect.sync(() => {
            const call = (params.toolCall ?? {}) as { kind?: ToolKind | null; title?: string | null };
            const options = params.options as readonly { optionId: string; kind: string }[];
            const ok = allowTool(call.kind ?? undefined, req.mode);
            const pick =
              options.find((o) => o.kind === (ok ? "allow_once" : "reject_once")) ??
              options.find((o) => o.kind.startsWith(ok ? "allow" : "reject"));
            if (!ok) {
              tools.blocked.push(call.title ?? call.kind ?? "tool");
              onDelta(`▸ Blocked by MultiCode: ${call.title ?? call.kind ?? "tool"}\n`);
            }
            return {
              outcome: pick
                ? { outcome: "selected", optionId: pick.optionId }
                : { outcome: "cancelled" },
            } as never;
          }),
        );
        yield* client.handleReadTextFile((params) =>
          Effect.tryPromise({
            try: async () => {
              const file = insideRoot(root, String(params.path ?? ""));
              const text = (await readFile(file, "utf8")).slice(0, MAX_READ);
              const line = typeof params.line === "number" ? Math.max(1, params.line) : 1;
              const limit = typeof params.limit === "number" ? params.limit : undefined;
              if (line === 1 && limit === undefined) return { content: text };
              const lines = text.split("\n");
              return {
                content: lines
                  .slice(line - 1, limit === undefined ? undefined : line - 1 + limit)
                  .join("\n"),
              };
            },
            catch: fail,
          }),
        );
        yield* client.handleWriteTextFile((params) =>
          Effect.tryPromise({
            try: async () => {
              if (req.mode !== "edit") throw new Error("this task is read-only");
              const file = insideRoot(root, String(params.path ?? ""));
              await mkdir(path.dirname(file), { recursive: true });
              await writeFile(file, String(params.content ?? ""));
              onDelta(`▸ Wrote ${path.relative(root, file)}\n`);
            },
            catch: fail,
          }),
        );
        yield* client.handleSessionUpdate((n) =>
          Effect.sync(() => onUpdate(n.update as unknown as Record<string, unknown>)),
        );
        return client;
      }),
    );
    return {
      client: session.service,
      close: session.close,
      ended: Effect.runPromise(Deferred.await(ended)),
    };
  }

  private async start(
    client: Client,
    req: GenerateRequest,
    cwd: string,
  ) {
    const init = (await run(
      client.agent.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: req.mode === "edit" },
          terminal: false,
        },
        clientInfo: { name: "multicode", title: "MultiCode", version: "0.1.0" },
      } as never),
    )) as InitResult;
    const mcpServers = await acpMcpServers(
      req.mcpServers ?? [],
      req.env ?? {},
      Boolean(init.agentCapabilities?.mcpCapabilities?.http),
    );
    try {
      return {
        init,
        created: (await run(
          client.agent.createSession({ cwd, mcpServers } as never),
        )) as unknown as NewSessionResult,
      };
    } catch (err) {
      const e = err as ProviderError & { code?: number };
      if (e.code === -32000 || /auth/i.test(e.message)) {
        const how = init.authMethods?.map((m) => m.name).join(" or ");
        throw new ProviderError(
          `${this.agentName} needs you to sign in first${how ? ` (${how})` : ""}. Run the agent once in a terminal to log in, then try again.`,
        );
      }
      throw err;
    }
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    let answer = "";
    let lastWasTool = false;
    const tools = { blocked: [] as string[] };
    const titles = new Map<string, string>();
    // Live view: message text streams; tool calls show as one "▸" line each.
    const onUpdate = (u: Record<string, unknown>) => {
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const c = u.content as { type?: string; text?: string } | undefined;
          if (c?.type === "text" && c.text) {
            if (lastWasTool && !answer.endsWith("\n")) onDelta("\n");
            lastWasTool = false;
            answer += c.text;
            onDelta(c.text);
          }
          break;
        }
        case "tool_call": {
          const id = String(u.toolCallId ?? "");
          const title = String(u.title ?? u.kind ?? "tool");
          titles.set(id, title);
          onDelta(`${answer && !lastWasTool ? "\n" : ""}▸ ${title}\n`);
          lastWasTool = true;
          break;
        }
        case "tool_call_update": {
          if (u.status === "failed")
            onDelta(`▸ ${titles.get(String(u.toolCallId)) ?? "tool"} failed\n`);
          break;
        }
      }
    };
    const session = await this.open(req.cwd, req, onDelta, tools, onUpdate);
    const { client } = session;
    let sessionId: string | undefined;
    const onAbort = () => {
      if (sessionId) void run(client.agent.cancel({ sessionId } as never)).catch(() => {});
      setTimeout(() => void session.close(), 1500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { created } = await race(this.start(client, req, req.cwd), session.ended, signal);
      sessionId = created.sessionId;
      const model = req.model || this.conn.defaultModel;
      if (model) await this.selectModel(client, created, model).catch(() => {});
      const res = (await race(
        run(
          client.agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: `${req.system}\n\n---\n\n${req.prompt}` }],
          } as never),
        ),
        session.ended,
        signal,
      )) as {
        stopReason?: string;
        usage?: { inputTokens?: number; outputTokens?: number } | null;
      };
      if (res.usage && (res.usage.inputTokens || res.usage.outputTokens))
        req.onUsage?.({
          input: res.usage.inputTokens ?? 0,
          output: res.usage.outputTokens ?? 0,
        });
      if (res.stopReason === "cancelled" || signal.aborted)
        throw new ProviderError("Cancelled");
      if (res.stopReason === "refusal")
        throw new ProviderError(`${this.agentName} refused the task`);
      return (
        answer.trim() ||
        (tools.blocked.length ? `(no answer; blocked: ${tools.blocked.join(", ")})` : "")
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      await session.close();
    }
  }

  private async selectModel(client: Client, created: NewSessionResult, model: string) {
    const { configId, values } = modelChoices(created);
    if (!values.includes(model)) return;
    if (configId)
      await run(
        client.agent.setSessionConfigOption({
          sessionId: created.sessionId,
          configId,
          value: model,
        } as never),
      );
    else
      await run(
        client.agent.setSessionModel({ sessionId: created.sessionId, modelId: model } as never),
      );
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const cwd = path.join(tmpdir(), "multicode-acp-probe");
    await mkdir(cwd, { recursive: true });
    const session = await this.open(cwd, { cwd, mode: "text" }, () => {}, { blocked: [] });
    try {
      const { created } = await race(
        this.start(session.client, { system: "", prompt: "", cwd, mode: "text" }, cwd),
        session.ended,
        signal,
      );
      return modelChoices(created).values;
    } finally {
      await session.close();
    }
  }
}

type Client = AcpClient.AcpClient["Service"];

/**
 * Keeps only JSON lines of the agent's stdout. Some agents print log lines there; T3 Code's ACP
 * client treats any non-JSON line as a protocol error, so they are dropped before it (the same
 * hook T3 Code uses for agents with extra stdout output).
 */
function jsonLinesOnly(stdout: Stream.Stream<Uint8Array, unknown>): Stream.Stream<Uint8Array, never> {
  return Stream.suspend(() => {
    let pending = "";
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const keep = (line: string) => line.trimStart().startsWith("{");
    return stdout.pipe(
      Stream.map((chunk) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        const out = lines.filter(keep).map((l) => l + "\n").join("");
        return encoder.encode(out);
      }),
      Stream.concat(
        Stream.suspend(() =>
          Stream.make(encoder.encode(keep(pending) ? pending + "\n" : "")),
        ),
      ),
      Stream.filter((b) => b.byteLength > 0),
      Stream.orDie,
    );
  }) as never;
}

/** Waits for `p`, failing early if the agent process ends or the run is cancelled. */
function race<T>(p: Promise<T>, ended: Promise<string>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderError("Cancelled"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, async (err) => {
      // A request that failed because the agent died: prefer the reason with its stderr tail.
      const why = await Promise.race([
        ended,
        new Promise<string>((r) => setTimeout(() => r(""), 300).unref()),
      ]);
      reject(why ? new ProviderError(why) : err);
    }).finally(() => signal.removeEventListener("abort", onAbort));
    void ended.then((why) => reject(new ProviderError(why || "The agent stopped")));
  });
}

/** Windows: npm launchers are .cmd shims that can't be spawned directly; resolve them. */
async function platformLaunch(launch: AcpLaunch): Promise<AcpLaunch> {
  if (path.isAbsolute(launch.command) && !/\.(cmd|bat)$/i.test(launch.command))
    return launch;
  const bin = path.isAbsolute(launch.command)
    ? launch.command
    : await findBinary(launch.command);
  if (!bin) throw new ProviderError(`"${launch.command}" not found`);
  const l = await resolveLaunch(bin);
  return {
    command: l.command,
    args: [...l.prefix, ...launch.args],
    env: { ...(l.env ?? {}), ...(launch.env ?? {}) },
  };
}

/** A connection's agent: a custom command, or an agent from the ACP registry. */
export async function launchForConnection(
  conn: Connection,
): Promise<AcpLaunch> {
  const acp = conn.acp;
  if (!acp) throw new ProviderError("This connection has no ACP agent");
  if (acp.command) return { command: acp.command, args: acp.args ?? [] };
  const agent = (await loadRegistry()).find((a) => a.id === acp.agentId);
  if (!agent)
    throw new ProviderError(
      `"${acp.agentName}" is no longer in the ACP registry`,
    );
  const r = await resolveAgent(agent);
  if (r.launch) return r.launch;
  if (r.needsInstall)
    throw new ProviderError(
      `${agent.name} isn't installed yet. Open Connections and press Install.`,
    );
  throw new ProviderError(
    r.reason ?? `${agent.name} can't run on this computer`,
  );
}
