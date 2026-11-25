// Runs T3 Code's Effect-based protocol clients (vendored under server/vendor/t3code) from
// MultiCode's promise-based providers: one scope per session owns the child process, and closing
// it stops the process (SIGTERM, then a forced kill) exactly as T3 Code does.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderError } from "./types.js";

export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Runs an effect that needs Node services (child processes, files) and returns a promise. */
export function run<A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
): Promise<A> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer))).then(
    (exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const code = (Cause.squash(exit.cause) as { code?: unknown })?.code;
      throw Object.assign(new ProviderError(describeCause(exit.cause)), {
        ...(typeof code === "number" ? { code } : {}),
      });
    },
  );
}

/** A readable message from an Effect failure (T3's tagged errors carry `message` or `detail`). */
export function describeCause(cause: Cause.Cause<unknown>): string {
  const err = Cause.squash(cause) as {
    message?: string;
    detail?: string;
    cause?: { message?: string };
  };
  const text =
    err?.detail || err?.message || err?.cause?.message || String(err ?? "failed");
  return text.trim() || "failed";
}

/** A session: a scope that owns the spawned process and everything built on it. */
export async function openSession<S>(
  launch: Launch,
  cwd: string,
  env: Record<string, string>,
  build: (
    child: ChildProcessSpawner.ChildProcessHandle,
  ) => Effect.Effect<S, unknown, Scope.Scope>,
): Promise<{ service: S; close: () => Promise<void> }> {
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
  try {
    const service = await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(launch.command, launch.args, {
            cwd,
            env: { ...(launch.env ?? {}), ...env },
            extendEnv: true,
            forceKillAfter: "2 seconds",
          }),
        );
        return yield* build(child);
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return { service, close };
  } catch (err) {
    await close();
    throw err;
  }
}
