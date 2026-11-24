import type { CrewMember, ProviderKind, Role } from "../../server/shared";

const PALETTE = ["#8EA4FF", "#FF8A7A", "#6FD6B0", "#C59CFF", "#5CC8E8", "#F2B544"];

export function colorFor(crew: CrewMember[], memberId?: string): string {
  const i = crew.findIndex((m) => m.id === memberId);
  return i < 0 ? "var(--muted)" : PALETTE[i % PALETTE.length]!;
}

export const ROLE_LABEL: Record<Role, string> = {
  architect: "Architect",
  builder: "Builder",
  reviewer: "Reviewer",
};

export const ROLE_HINT: Record<Role, string> = {
  architect: "Splits your request into tasks",
  builder: "Writes the code, in parallel with other builders",
  reviewer: "Checks the result and sends fixes back",
};

export const VENDOR: Record<ProviderKind, string> = {
  anthropic: "Claude",
  "claude-cli": "Claude",
  openai: "OpenAI",
  "codex-cli": "ChatGPT",
  gemini: "Gemini",
  "gemini-cli": "Gemini",
  "openai-compatible": "Custom",
  "opencode-cli": "OpenCode",
  "qwen-cli": "Qwen",
};

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}
