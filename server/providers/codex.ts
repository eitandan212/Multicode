// Codex through its app-server (as T3 Code does): one `codex app-server` process speaking Codex's
// own JSON-RPC protocol (initialize, thread/start, turn/start, streamed item events) instead of
// parsing `codex exec` output. Sign-in is checked up front, the system prompt goes in as
// developer instructions, and the safety is the same as `codex exec`: a workspace-write (or
// read-only) sandbox with approvals set to "never"; any approval request that still arrives is
// declined for commands, and allowed for file changes only in edit tasks.
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Connection } from "../config.js";
import { codexMcpArgs } from "../sync.js";
import { findBinary, resolveLaunch } from "./cli.js";
import { JsonRpcChild, type RpcLaunch } from "./jsonrpc.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

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

export class CodexAppServerProvider implements Provider {
  readonly editsFiles = true;

  constructor(
    private conn: Connection,
    private launchFor: () => Promise<RpcLaunch> = defaultLaunch,
  ) {}

  private async open(
    cwd: string,
    req: Pick<GenerateRequest, "mode" | "env" | "mcpServers">,
    onNotify: (method: string, params: Record<string, unknown>) => void,
    /** Listing models works signed out; running a turn doesn't. */
    needsSignIn = true,
  ) {
    const base = await this.launchFor();
    const launch = {
      ...base,
      args: [...base.args, ...codexAppServerArgs(req)],
    };
    await mkdir(cwd, { recursive: true });
    const child = new JsonRpcChild(
      launch,
      cwd,
      req.env ?? {},
      async (method) => {
        const answer = codexApproval(method, req.mode);
        if (answer) return answer;
        throw Object.assign(new Error(`MultiCode doesn't support ${method}`), {
          code: -32601,
        });
      },
      onNotify,
    );
    // Don't leave the process behind when the handshake or the sign-in check fails.
    try {
      await child.request("initialize", {
        clientInfo: CLIENT,
        capabilities: { experimentalApi: true },
      });
      child.notify("initialized", undefined);
      const account = await child.request<{
        account: unknown;
        requiresOpenaiAuth?: boolean;
      }>("account/read", {});
      if (needsSignIn && !account.account && account.requiresOpenaiAuth)
        throw new ProviderError(
          "Codex isn't signed in. Run `codex login` in a terminal once, then try again.",
        );
    } catch (err) {
      child.kill();
      throw err;
    }
    return child;
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
    let finish!: (status: string, error?: string) => void;
    const done = new Promise<{ status: string; error?: string }>(
      (resolve) => (finish = (status, error) => resolve({ status, error })),
    );

    const child = await this.open(req.cwd, req, (method, params) => {
      if (
        threadId &&
        params.threadId !== undefined &&
        params.threadId !== threadId
      )
        return;
      switch (method) {
        case "item/agentMessage/delta": {
          const delta = String(params.delta ?? "");
          answer += delta;
          onDelta(delta);
          break;
        }
        case "item/started": {
          const label = codexItemLabel((params.item ?? {}) as ThreadItem);
          if (label)
            onDelta(
              `${answer && !answer.endsWith("\n") ? "\n" : ""}▸ ${label}\n`,
            );
          break;
        }
        case "thread/tokenUsage/updated": {
          const t = (params.tokenUsage as { total?: TokenUsage } | undefined)
            ?.total;
          if (t) usage = t;
          break;
        }
        case "error": {
          const e = params as {
            error?: { message?: string; additionalDetails?: string | null };
            willRetry?: boolean;
          };
          if (!e.willRetry)
            lastError = [e.error?.message, e.error?.additionalDetails]
              .filter(Boolean)
              .join(": ");
          break;
        }
        case "turn/completed": {
          const turn = (params.turn ?? {}) as {
            id?: string;
            status?: string;
            error?: { message?: string } | null;
          };
          if (!turnId || turn.id === turnId)
            finish(turn.status ?? "completed", turn.error?.message);
          break;
        }
      }
    });

    const onAbort = () => {
      if (threadId && turnId)
        void child
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => {});
      setTimeout(() => child.kill(), 1500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const thread = await child.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: req.cwd,
          sandbox: req.mode === "edit" ? "workspace-write" : "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          developerInstructions: req.system,
          ...(req.model || this.conn.defaultModel
            ? { model: req.model || this.conn.defaultModel }
            : {}),
        },
      );
      threadId = thread.thread.id;
      const turn = await child.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: req.prompt, text_elements: [] }],
      });
      turnId = turn.turn.id;
      const exited = child.exited.then((code) => ({
        status: "failed",
        error: child.failure(code),
      }));
      const result = await Promise.race([done, exited]);
      if (usage)
        req.onUsage?.({ input: usage.inputTokens, output: usage.outputTokens });
      if (signal.aborted || result.status === "interrupted")
        throw new ProviderError("Cancelled");
      if (result.status === "failed")
        throw new ProviderError(result.error || lastError || "Codex failed");
      return answer.trim();
    } finally {
      signal.removeEventListener("abort", onAbort);
      child.kill();
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const cwd = path.join(tmpdir(), "multicode-codex-probe");
    const child = await this.open(cwd, { mode: "text" }, () => {}, false);
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const out: string[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          data: { id: string; hidden?: boolean }[];
          nextCursor: string | null;
        } = await child.request("model/list", cursor ? { cursor } : {});
        out.push(...page.data.filter((m) => !m.hidden).map((m) => m.id));
        cursor = page.nextCursor;
      } while (cursor && out.length < 500);
      return out;
    } finally {
      signal.removeEventListener("abort", stop);
      child.kill();
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
