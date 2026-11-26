import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Connection } from "../config.js";
import {
  ProviderError,
  type DeltaHandler,
  type GenerateRequest,
  type Provider,
} from "./types.js";

const MAX_OUTPUT_TOKENS = 64_000;

export const DEFAULT_MODELS: Partial<Record<Connection["kind"], string>> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
};

function requireModel(req: GenerateRequest, conn: Connection): string {
  const model = req.model || conn.defaultModel || DEFAULT_MODELS[conn.kind];
  if (!model)
    throw new ProviderError(
      `No model set for "${conn.label}". Pick one in Connections.`,
    );
  return model;
}

export class AnthropicProvider implements Provider {
  readonly editsFiles = false;
  private client: Anthropic;

  constructor(private conn: Connection) {
    this.client = new Anthropic({
      apiKey: conn.apiKey,
      baseURL: conn.baseUrl || undefined,
      ...(conn.headers ? { defaultHeaders: conn.headers } : {}),
    });
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const model = requireModel(req, this.conn);
    // Current-generation models can decline on safety grounds; let the API reroute such
    // requests to a fallback model instead of failing the whole crew run.
    const fallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(this.conn.effort ? { output_config: { effort: this.conn.effort } } : {}),
        // The system text is fixed per role, so it is cached across calls (~90% cheaper on a hit).
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: req.images?.length
              ? [
                  ...req.images.map((im) => ({
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: im.mediaType, data: im.data },
                  })),
                  { type: "text" as const, text: req.prompt },
                ]
              : req.prompt,
          },
        ],
        ...(fallback
          ? {
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default" as const,
            }
          : {}),
      },
      { signal },
    );
    stream.on("text", (t) => onDelta(t));
    const message = await stream.finalMessage();
    req.onUsage?.({
      input:
        message.usage.input_tokens +
        (message.usage.cache_creation_input_tokens ?? 0),
      cached: message.usage.cache_read_input_tokens ?? 0,
      output: message.usage.output_tokens,
    });
    if (message.stop_reason === "refusal")
      throw new ProviderError("The model declined this request.");
    const text = message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    if (message.stop_reason === "max_tokens")
      return `${text}\n<!-- output truncated: max_tokens -->`;
    return text;
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }
}

export class OpenAIProvider implements Provider {
  readonly editsFiles = false;
  private client: OpenAI;

  constructor(private conn: Connection) {
    this.client = new OpenAI({
      apiKey: conn.apiKey || "not-needed",
      baseURL: conn.baseUrl || undefined,
      ...(conn.headers ? { defaultHeaders: conn.headers } : {}),
    });
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: requireModel(req, this.conn),
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            // Local OpenAI-compatible servers often can't take images: only OpenAI itself gets them.
            content:
              req.images?.length && this.conn.kind === "openai"
                ? [
                    { type: "text" as const, text: req.prompt },
                    ...req.images.map((im) => ({
                      type: "image_url" as const,
                      image_url: { url: `data:${im.mediaType};base64,${im.data}` },
                    })),
                  ]
                : req.prompt,
          },
        ],
      },
      { signal },
    );
    let text = "";
    for await (const chunk of stream) {
      if (chunk.usage)
        req.onUsage?.({
          input: chunk.usage.prompt_tokens - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
          cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          output: chunk.usage.completion_tokens,
        });
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
    }
    return text;
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids.sort();
  }
}

export class GeminiProvider implements Provider {
  readonly editsFiles = false;
  private client: GoogleGenAI;

  constructor(private conn: Connection) {
    this.client = new GoogleGenAI({
      apiKey: conn.apiKey,
      ...(conn.baseUrl || conn.headers
        ? {
            httpOptions: {
              ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}),
              ...(conn.headers ? { headers: conn.headers } : {}),
            },
          }
        : {}),
    });
  }

  async generate(
    req: GenerateRequest,
    onDelta: DeltaHandler,
    signal: AbortSignal,
  ): Promise<string> {
    const stream = await this.client.models.generateContentStream({
      model: requireModel(req, this.conn),
      contents: req.images?.length
        ? [
            {
              role: "user",
              parts: [
                ...req.images.map((im) => ({ inlineData: { mimeType: im.mediaType, data: im.data } })),
                { text: req.prompt },
              ],
            },
          ]
        : req.prompt,
      config: { systemInstruction: req.system, abortSignal: signal },
    });
    let text = "";
    let usage: { input: number; cached: number; output: number } | undefined;
    for await (const chunk of stream) {
      const u = chunk.usageMetadata;
      if (u)
        usage = {
          input: (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0),
          cached: u.cachedContentTokenCount ?? 0,
          output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        };
      const delta = chunk.text;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
    }
    if (usage) req.onUsage?.(usage);
    return text;
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    const pager = await this.client.models.list();
    for await (const m of pager) {
      if (
        m.name &&
        (m.supportedActions ?? ["generateContent"]).includes("generateContent")
      )
        ids.push(m.name.replace(/^models\//, ""));
    }
    return ids;
  }
}
