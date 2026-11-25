// Tries the native connection (Codex app-server, Claude Agent SDK) and falls back to the plain CLI
// mode when the native one can't start at all (e.g. an older Codex without `app-server`). It
// never falls back once output has streamed, nor for sign-in, usage-limit or cancel errors:
// those would fail the same way, or the work has already begun.
import {
  isLimitError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

const FINAL =
  /cancelled|sign(ed)? in|log ?in|not found\. install|usage limit|rate.?limit/i;

export class FallbackProvider implements Provider {
  readonly editsFiles: boolean;
  /** Set once the native mode failed to start; later calls go straight to the fallback. */
  private nativeBroken = false;

  constructor(
    private primary: Provider,
    private fallback: Provider,
  ) {
    this.editsFiles = primary.editsFiles;
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.nativeBroken) return this.fallback.generate(req, onDelta, signal);
    let streamed = false;
    try {
      return await this.primary.generate(
        req,
        (t) => {
          streamed = true;
          onDelta(t);
        },
        signal,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (streamed || signal.aborted || FINAL.test(msg) || isLimitError(msg))
        throw err;
      this.nativeBroken = true;
      return this.fallback.generate(req, onDelta, signal);
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    if (this.primary.listModels) {
      try {
        return await this.primary.listModels(signal);
      } catch {
        // fall through to the CLI's own listing, if any
      }
    }
    return this.fallback.listModels ? this.fallback.listModels(signal) : [];
  }
}
