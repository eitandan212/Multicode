// Official brand marks from @lobehub/icons (MIT). The logos are trademarks of their owners;
// MultiCode shows them only to identify which service a connection uses.
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg?raw";
import claudecode from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import geminicli from "@lobehub/icons-static-svg/icons/geminicli-color.svg?raw";
import githubcopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg?raw";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import type { ProviderKind } from "../../../server/shared";

const BY_KIND: Record<ProviderKind, string> = {
  anthropic,
  "claude-cli": claudecode,
  openai,
  "codex-cli": codex,
  gemini,
  "gemini-cli": geminicli,
  "opencode-cli": opencode,
  "qwen-cli": qwen,
  "openai-compatible": openai,
};

/** Which brand an OpenAI-compatible endpoint (or a model id) belongs to. */
function brandFor(baseUrl = "", model = ""): string | undefined {
  const u = baseUrl.toLowerCase();
  const m = model.toLowerCase();
  if (u.includes("openrouter")) return openrouter;
  if (u.includes("groq")) return groq;
  if (u.includes("deepseek") || m.includes("deepseek")) return deepseek;
  if (u.includes("mistral") || m.includes("mistral")) return mistral;
  if (u.includes(":11434") || u.includes("ollama")) return ollama;
  if (u.includes(":1234") || u.includes("lmstudio")) return lmstudio;
  if (m.startsWith("github-copilot/")) return githubcopilot;
  // Model families, e.g. on OpenRouter ("anthropic/claude-…", "openai/gpt-…").
  if (m.includes("claude")) return claude;
  if (m.includes("gemini")) return gemini;
  if (/(^|\/)(gpt|o\d|codex)/.test(m)) return openai;
  if (m.includes("qwen")) return qwen;
  if (m.includes("kimi") || m.includes("moonshot")) return kimi;
  if (m.includes("grok")) return grok;
  if (m.includes("glm")) return zhipu;
  return undefined;
}

// The logos are decorative (the name is always shown next to them), so drop their <title>.
const clean = new Map<string, string>();
const strip = (svg: string) => {
  let out = clean.get(svg);
  if (!out) clean.set(svg, (out = svg.replace(/<title>[\s\S]*?<\/title>/, "")));
  return out;
};

export function ProviderLogo({ kind, baseUrl, model, size = 16 }: { kind: ProviderKind; baseUrl?: string; model?: string; size?: number }) {
  const svg = strip(
    (kind === "openai-compatible" || kind === "opencode-cli" ? brandFor(kind === "opencode-cli" ? "" : baseUrl, model) : undefined) ?? BY_KIND[kind],
  );
  // Static SVG files bundled at build time, never user input.
  return <span className="logo" style={{ fontSize: size }} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}
