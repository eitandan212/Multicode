// Codex through its app-server, with T3 Code's own client: `effect-codex-app-server` (vendored
// from T3 Code, MIT, under server/vendor/t3code) speaks Codex's JSON-RPC protocol with Codex's
// generated schemas, the same way T3 Code launches it (initialize, account/read, thread/start,
// turn/start, streamed item events). Sign-in is checked up front, the system prompt goes in as
// developer instructions, and the safety is the same as `codex exec`: a workspace-write (or
// read-only) sandbox with approvals set to "never"; any approval request that still arrives is
// declined for commands, and allowed for file changes only in edit tasks.
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CodexClient from "../vendor/t3code/effect-codex-app-server/client.ts";
import type { Connection } from "../config.js";
import { codexMcpArgs } from "../sync.js";
import { findBinary, resolveLaunch } from "./cli.js";
import { openSession, run, type Launch } from "./t3bridge.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

export type RpcLaunch = Launch;

const CLIENT = { name: "multicode", title: "MultiCode", version: "0.1.0" };

/** argv for the app-server: Codex's own unload delay would only keep finished threads around. */
export function codexAppServerArgs(
  req: Pick<GenerateRequest, "mcpServers">,
): string[] {
  return [
    "app-server",
    "-c",
    "thread_unload_delay_secs=0",
    ...codexMcpArgs(req.mcpServers ?? []),
  ];
}

/** How MultiCode answers Codex's approval requests (it normally asks none: approvals are "never"). */
export function codexApproval(
  method: string,
  mode: GenerateRequest["mode"],
): { decision: string } | undefined {
  if (method === "item/commandExecution/requestApproval")
    return { decision: "decline" };
  if (method === "item/fileChange/requestApproval")
    return { decision: mode === "edit" ? "accept" : "decline" };
  return undefined;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
interface ThreadItem {
  type: string;
  command?: string;
  changes?: { path?: string }[];
  server?: string;
  tool?: string;
}

/** A one-line label for an item Codex starts, for the live view. */
export function codexItemLabel(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return `$ ${String(item.command ?? "").slice(0, 160)}`;
    case "fileChange": {
      const files = (item.changes ?? []).map((c) => c.path).filter(Boolean);
      return files.length
        ? `Edit ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` +${files.length - 4}` : ""}`
        : "Edit files";
    }
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
    case "webSearch":
      return "Web search";
    default:
      return undefined;
  }
}

type Client = CodexClient.CodexAppServerClient["Service"];

export class CodexAppServerProvider implements Provider {
  readonly editsFiles = true;

  constructor(
    private conn: Connection,
    private launchFor: () => Promise<Launch> = defaultLaunch,
  ) {}

  /** Starts `codex app-server`, registers handlers, and runs the handshake (as T3 Code does). */
  private async open(
    cwd: string,
    req: Pick<GenerateRequest, "mode" | "env" | "mcpServers">,
    register: (client: Client) => Effect.Effect<void>,
    /** Listing models works signed out; running a turn doesn't. */
    needsSignIn = true,
  ) {
    const base = await this.launchFor();
    await mkdir(cwd, { recursive: true });
    const session = await openSession(
      { ...base, args: [...base.args, ...codexAppServerArgs(req)] },
      cwd,
      req.env ?? {},
      (child) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(CodexClient.layerChildProcess(child));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          yield* client.handleServerRequest("item/commandExecution/requestApproval", () =>
            Effect.succeed(codexApproval("item/commandExecution/requestApproval", req.mode) as never),
          );
          yield* client.handleServerRequest("item/fileChange/requestApproval", () =>
            Effect.succeed(codexApproval("item/fileChange/requestApproval", req.mode) as never),
          );
          yield* register(client);
          yield* client.request("initialize", {
            clientInfo: CLIENT,
            capabilities: { experimentalApi: true },
          } as never);
          yield* client.notify("initialized", undefined as never);
          const account = (yield* client.request("account/read", {} as never)) as {
            account: unknown;
            requiresOpenaiAuth?: boolean;
          };
          if (needsSignIn && !account.account && account.requiresOpenaiAuth)
            return yield* Effect.fail(
              new ProviderError(
                "Codex isn't signed in. Run `codex login` in a terminal once, then try again.",
              ),
            );
          return client;
        }),
    );
    return { client: session.service, close: session.close };
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    let answer = "";
    let threadId = "";
    let turnId = "";
    let usage: TokenUsage | undefined;
    let lastError = "";
    const done = await Effect.runPromise(
      Deferred.make<{ status: string; error?: string }>(),
    );
    const finish = (status: string, error?: string) =>
      Deferred.succeed(done, { status, ...(error ? { error } : {}) });
    const mine = (p: { threadId?: string }) =>
      !threadId || p.threadId === undefined || p.threadId === threadId;

    const { client, close } = await this.open(req.cwd, req, (client) =>
      Effect.gen(function* () {
        yield* client.handleServerNotification("item/agentMessage/delta", (p) =>
          Effect.sync(() => {
            if (!mine(p)) return;
            answer += p.delta;
            onDelta(p.delta);
          }),
        );
        yield* client.handleServerNotification("item/started", (p) =>
          Effect.sync(() => {
            if (!mine(p)) return;
            const label = codexItemLabel(p.item as ThreadItem);
            if (label)
              onDelta(`${answer && !answer.endsWith("\n") ? "\n" : ""}▸ ${label}\n`);
          }),
        );
        yield* client.handleServerNotification("thread/tokenUsage/updated", (p) =>
          Effect.sync(() => {
            if (mine(p)) usage = p.tokenUsage.total;
          }),
        );
        yield* client.handleServerNotification("error", (p) =>
          Effect.sync(() => {
            if (mine(p) && !p.willRetry)
              lastError = [p.error.message, p.error.additionalDetails].filter(Boolean).join(": ");
          }),
        );
        yield* client.handleServerNotification("turn/completed", (p) => {
          if (!mine(p) || (turnId && p.turn.id !== turnId)) return Effect.void;
          return finish(p.turn.status, p.turn.error?.message ?? undefined).pipe(Effect.asVoid);
        });
      }),
    );

    const onAbort = () => {
      if (threadId && turnId)
        void run(client.request("turn/interrupt", { threadId, turnId } as never)).catch(() => {});
      setTimeout(() => void close(), 1500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const thread = await run(
        client.request("thread/start", {
          cwd: req.cwd,
          sandbox: req.mode === "edit" ? "workspace-write" : "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          developerInstructions: req.system,
          ...(req.model || this.conn.defaultModel
            ? { model: req.model || this.conn.defaultModel }
            : {}),
        } as never),
      );
      threadId = thread.thread.id;
      const turn = await run(
        client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: req.prompt, text_elements: [] }],
        } as never),
      );
      turnId = turn.turn.id;
      const result = await run(
        Effect.raceFirst(
          Deferred.await(done),
          client.awaitTermination.pipe(
            Effect.catch((e) =>
              Effect.succeed({ status: "failed", error: (e as { message?: string }).message }),
            ),
          ),
        ),
      );
      if (usage)
        req.onUsage?.({ input: usage.inputTokens, output: usage.outputTokens });
      if (signal.aborted || result.status === "interrupted")
        throw new ProviderError("Cancelled");
      if (result.status === "failed")
        throw new ProviderError(result.error || lastError || "Codex failed");
      return answer.trim();
    } catch (err) {
      if (signal.aborted) throw new ProviderError("Cancelled");
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
      await close();
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const cwd = path.join(tmpdir(), "multicode-codex-probe");
    const { client, close } = await this.open(cwd, { mode: "text" }, () => Effect.void, false);
    const stop = () => void close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const out: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: readonly { id: string; hidden?: boolean }[]; nextCursor?: string | null } =
          await run(client.request("model/list", (cursor ? { cursor } : {}) as never));
        out.push(...page.data.filter((m) => !m.hidden).map((m) => m.id));
        cursor = page.nextCursor ?? null;
      } while (cursor && out.length < 500);
      return out;
    } finally {
      signal.removeEventListener("abort", stop);
      await close();
    }
  }
}

async function defaultLaunch(): Promise<RpcLaunch> {
  const bin = await findBinary("codex");
  if (!bin)
    throw new ProviderError(
      '"codex" not found. Install: npm i -g @openai/codex, then run `codex login`',
    );
  const l = await resolveLaunch(bin);
  return { command: l.command, args: [...l.prefix], env: l.env };
}
