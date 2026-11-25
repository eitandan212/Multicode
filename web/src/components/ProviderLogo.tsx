// Official brand marks from @lobehub/icons (MIT). The logos are trademarks of their owners;
// MultiCode shows them only to identify which service a connection uses.
import amp from "@lobehub/icons-static-svg/icons/amp-color.svg?raw";
import antigravity from "@lobehub/icons-static-svg/icons/antigravity-color.svg?raw";
import cline from "@lobehub/icons-static-svg/icons/cline.svg?raw";
import codebuddy from "@lobehub/icons-static-svg/icons/codebuddy-color.svg?raw";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import devin from "@lobehub/icons-static-svg/icons/devin-color.svg?raw";
import goose from "@lobehub/icons-static-svg/icons/goose.svg?raw";
import junie from "@lobehub/icons-static-svg/icons/junie-color.svg?raw";
import kilocode from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kiro from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import poolside from "@lobehub/icons-static-svg/icons/poolside-color.svg?raw";
import qoder from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
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
import type {
  ConnectionView,
  CrewMember,
  ProviderKind,
} from "../../../server/shared";

/** Neutral mark for endpoints whose maker we can't tell: never borrow another company's logo. */
const generic =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';

const BY_KIND: Record<ProviderKind, string> = {
  anthropic,
  "claude-cli": claudecode,
  openai,
  "codex-cli": codex,
  gemini,
  "gemini-cli": geminicli,
  antigravity,
  "opencode-cli": opencode,
  "qwen-cli": qwen,
  "openai-compatible": generic,
  acp: generic,
};

/** ACP registry agents with a bundled official mark; others use the registry's own icon. */
const BY_AGENT: Record<string, string> = {
  "claude-acp": claudecode,
  "codex-acp": codex,
  gemini: geminicli,
  opencode,
  "opencode-v2": opencode,
  "qwen-code": qwen,
  "github-copilot-cli": githubcopilot,
  cursor,
  goose,
  kiro,
  cline,
  qoder,
  junie,
  "amp-acp": amp,
  devin,
  kilo: kilocode,
  kimi,
  "kimi-code": kimi,
  "minimax-code": minimax,
  "mistral-vibe": mistral,
  poolside,
  "codebuddy-code": codebuddy,
  "grok-build": grok,
  "glm-acp-agent": zhipu,
};

export interface AcpLogoRef {
  agentId: string;
  icon?: string;
}

/** The maker of a model, from its id ("anthropic/claude-…", "gpt-5", "deepseek-chat"…). */
function modelBrand(model = ""): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith("github-copilot/")) return githubcopilot;
  if (m.includes("claude")) return claude;
  if (m.includes("gemini")) return gemini;
  if (/(^|\/)(gpt|o\d|codex|chatgpt)/.test(m)) return openai;
  if (m.includes("deepseek")) return deepseek;
  if (m.includes("qwen")) return qwen;
  if (m.includes("mistral") || m.includes("codestral")) return mistral;
  if (m.includes("kimi") || m.includes("moonshot")) return kimi;
  if (m.includes("grok")) return grok;
  if (m.includes("glm")) return zhipu;
  return undefined;
}

/** The service behind an endpoint, when the model doesn't say who made it. */
function endpointBrand(baseUrl = ""): string | undefined {
  const u = baseUrl.toLowerCase();
  if (u.includes("openrouter")) return openrouter;
  if (u.includes("groq")) return groq;
  if (u.includes("deepseek")) return deepseek;
  if (u.includes("mistral")) return mistral;
  if (u.includes(":11434") || u.includes("ollama")) return ollama;
  if (u.includes(":1234") || u.includes("lmstudio")) return lmstudio;
  return undefined;
}

// The logos are decorative (the name is always shown next to them), so drop their <title>.
const clean = new Map<string, string>();
const strip = (svg: string) => {
  let out = clean.get(svg);
  if (!out) clean.set(svg, (out = svg.replace(/<title>[\s\S]*?<\/title>/, "")));
  return out;
};

export function ProviderLogo({
  kind,
  baseUrl,
  model,
  acp,
  size = 16,
}: {
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  acp?: AcpLogoRef;
  size?: number;
}) {
  // The model's maker comes first (Opus 5.5 through Claude Code shows Claude's mark, GPT-5
  // through Codex shows OpenAI's); the harness or service mark is the fallback.
  const maker = modelBrand(model);
  if (!maker && kind === "acp" && acp && !BY_AGENT[acp.agentId] && acp.icon)
    return <AgentIcon icon={acp.icon} size={size} />;
  const svg = strip(
    maker ??
      (kind === "acp" && acp ? BY_AGENT[acp.agentId] : undefined) ??
      (kind === "openai-compatible" ? endpointBrand(baseUrl) : undefined) ??
      BY_KIND[kind],
  );
  // Static SVG files bundled at build time, never user input.
  return (
    <span
      className="logo"
      style={{ fontSize: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * A registry icon (monochrome SVG on cdn.agentclientprotocol.com), drawn as a mask so it takes
 * the text colour in both themes. Only that host is used; anything else falls back to the
 * neutral mark.
 */
export function AgentIcon({
  icon,
  size = 16,
}: {
  icon: string;
  size?: number;
}) {
  if (!/^https:\/\/cdn\.agentclientprotocol\.com\/[\w./-]+\.svg$/.test(icon))
    return (
      <span
        className="logo"
        style={{ fontSize: size }}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: generic }}
      />
    );
  const url = `url("${icon}")`;
  return (
    <span
      className="logo agent-icon"
      aria-hidden
      style={{
        width: size,
        height: size,
        WebkitMaskImage: url,
        maskImage: url,
      }}
    />
  );
}

/** The bundled mark for a registry agent, if MultiCode ships one. */
export function hasBundledAgentLogo(agentId: string): boolean {
  return Boolean(BY_AGENT[agentId]);
}

/** A crew member's mark: the logo of the model's maker (Claude for Opus 5.5 via Claude Code…). */
export function MemberLogo({
  member,
  connections,
  size = 14,
}: {
  member: CrewMember;
  connections: ConnectionView[];
  size?: number;
}) {
  const c = connections.find((x) => x.id === member.connectionId);
  if (!c) return null;
  return (
    <ProviderLogo
      kind={c.kind}
      acp={c.acp}
      baseUrl={c.baseUrl}
      model={member.model || c.defaultModel}
      size={size}
    />
  );
}
