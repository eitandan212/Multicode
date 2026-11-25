// Subscription limits as Claude's /usage shows them: how much of each window is used and when it
// resets. Read the way T3 Code reads them: Claude through the Agent SDK's usage request (a
// session that never sends a prompt), Codex through its app-server (account/rateLimits/read).
// Nothing here spends tokens.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import type { Connection } from "./config.js";
import { installedClaude } from "./providers/claude.js";
import { CodexAppServerProvider, type CodexRateLimits, type CodexRateWindow } from "./providers/codex.js";
import type { AccountUsage, UsageWindow } from "./shared.js";

const CACHE_MS = 60_000;
const cache = new Map<string, AccountUsage>();

const pct = (n: number | null | undefined) => Math.max(0, Math.min(100, Number(n ?? 0)));
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface ClaudeRateLimits {
  five_hour?: { utilization: number | null; resets_at: string | null } | null;
  seven_day?: { utilization: number | null; resets_at: string | null } | null;
  seven_day_opus?: { utilization: number | null; resets_at: string | null } | null;
  seven_day_sonnet?: { utilization: number | null; resets_at: string | null } | null;
  model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
    currency?: string | null;
  } | null;
}

/** Claude's windows from a get_usage answer. */
export function claudeWindows(r: ClaudeRateLimits): { windows: UsageWindow[]; extra?: string } {
  const windows: UsageWindow[] = [];
  const add = (id: string, label: string, w?: { utilization: number | null; resets_at: string | null } | null) => {
    if (!w || w.utilization === null) return;
    windows.push({ id, label, usedPercent: pct(w.utilization), ...(w.resets_at ? { resetsAt: w.resets_at } : {}) });
  };
  add("five_hour", "Session (5 hours)", r.five_hour);
  add("seven_day", "Weekly · all models", r.seven_day);
  add("seven_day_opus", "Weekly · Opus", r.seven_day_opus);
  add("seven_day_sonnet", "Weekly · Sonnet", r.seven_day_sonnet);
  for (const m of r.model_scoped ?? [])
    add(`model_${m.display_name}`, `Weekly · ${m.display_name}`, m);
  const x = r.extra_usage;
  const extra =
    x?.is_enabled && x.monthly_limit
      ? `Extra usage: ${x.used_credits ?? 0} of ${x.monthly_limit}${x.currency ? ` ${x.currency}` : ""} this month`
      : undefined;
  return { windows, ...(extra ? { extra } : {}) };
}

/** Codex's windows: primary is the short window (5 hours on paid plans), secondary the weekly. */
export function codexWindows(r: CodexRateLimits): { windows: UsageWindow[]; plan?: string; extra?: string } {
  const s = r.rateLimits ?? {};
  const monthly = /free|go/i.test(s.planType ?? "");
  const windows: UsageWindow[] = [];
  const add = (id: string, w: CodexRateWindow | null | undefined, fallbackMins: number) => {
    if (!w) return;
    const mins = w.windowDurationMins ?? fallbackMins;
    const label =
      mins <= 6 * 60
        ? `Session (${Math.round(mins / 60)} hours)`
        : mins <= 8 * 24 * 60
          ? "Weekly"
          : "Monthly";
    windows.push({
      id,
      label,
      usedPercent: pct(w.usedPercent),
      ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
    });
  };
  add("primary", s.primary, monthly ? 30 * 24 * 60 : 5 * 60);
  add("secondary", s.secondary, 7 * 24 * 60);
  const extra = s.credits?.unlimited
    ? "Unlimited credits"
    : s.credits?.hasCredits && s.credits.balance
      ? `Credits left: ${s.credits.balance}`
      : undefined;
  return { windows, ...(s.planType ? { plan: title(s.planType) } : {}), ...(extra ? { extra } : {}) };
}

async function readClaude(): Promise<{ plan?: string; windows: UsageWindow[]; extra?: string }> {
  const abort = new AbortController();
  const q = query({
    // Never yields: no prompt reaches the API, the session only answers control requests.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
    })(),
    options: { ...(await installedClaude()), cwd: tmpdir(), abortController: abort, persistSession: false },
  });
  try {
    const init = (await q.initializationResult()) as { account?: { subscriptionType?: string } };
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const plan = u.subscription_type ?? init.account?.subscriptionType ?? undefined;
    if (!u.rate_limits_available || !u.rate_limits)
      return { ...(plan ? { plan: title(plan) } : {}), windows: [] };
    return { ...(plan ? { plan: title(plan) } : {}), ...claudeWindows(u.rate_limits as ClaudeRateLimits) };
  } finally {
    abort.abort();
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, j) => setTimeout(() => j(new Error("didn't answer in time")), ms).unref())]);

/** The limits of one subscription connection (cached for a minute; `fresh` skips the cache). */
export async function accountUsage(conn: Connection, fresh = false): Promise<AccountUsage> {
  const hit = cache.get(conn.id);
  if (hit && !fresh && Date.now() - hit.checkedAt < CACHE_MS) return hit;
  const base = { connectionId: conn.id, label: conn.label, kind: conn.kind, checkedAt: Date.now() };
  let out: AccountUsage;
  try {
    const r =
      conn.kind === "claude-cli"
        ? await withTimeout(readClaude(), 30_000)
        : await withTimeout(new CodexAppServerProvider(conn).rateLimits().then(codexWindows), 30_000);
    out = { ...base, ...r };
  } catch (err) {
    out = { ...base, windows: [], error: (err as Error).message.slice(0, 300) };
  }
  cache.set(conn.id, out);
  return out;
}

/** Subscriptions that report their limits. */
export const USAGE_KINDS = ["claude-cli", "codex-cli"] as const;
