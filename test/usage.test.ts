import { describe, expect, it } from "vitest";
import { claudeWindows, codexWindows } from "../server/usage.js";

describe("subscription limits", () => {
  it("reads Claude's windows: session, weekly, per-model, extra usage", () => {
    const r = claudeWindows({
      five_hour: { utilization: 42, resets_at: "2026-11-26T03:00:00Z" },
      seven_day: { utilization: 17.5, resets_at: "2026-12-01T09:00:00Z" },
      seven_day_opus: { utilization: 60, resets_at: "2026-12-01T09:00:00Z" },
      seven_day_sonnet: null,
      model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12, utilization: 24, currency: "USD" },
    });
    expect(r.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Session (5 hours)", 42],
      ["Weekly · all models", 17.5],
      ["Weekly · Opus", 60],
      ["Weekly · Fable", 3],
    ]);
    expect(r.windows[0]!.resetsAt).toBe("2026-11-26T03:00:00Z");
    expect(r.extra).toBe("Extra usage: 12 of 50 USD this month");
  });

  it("reads Codex's windows: 5-hour and weekly on paid plans, monthly on Free", () => {
    const paid = codexWindows({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1795640400 },
        secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1796000000 },
      },
    });
    expect(paid.plan).toBe("Plus");
    expect(paid.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Session (5 hours)", 80],
      ["Weekly", 30],
    ]);
    expect(paid.windows[0]!.resetsAt).toBe(new Date(1795640400 * 1000).toISOString());
    const free = codexWindows({ rateLimits: { planType: "free", primary: { usedPercent: 5 } } });
    expect(free.windows[0]!.label).toBe("Monthly");
  });
});
