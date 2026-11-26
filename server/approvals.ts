import { randomUUID } from "node:crypto";
import type { ApprovalAsk, ApprovalMode, RunEvent } from "./shared.js";

/**
 * One run's approvals (as in Claude Code): an agent action waits here until you allow or
 * decline it in the thread. "Allow all" for a kind stops asking for that kind in this run.
 * Cancelling the run declines everything still waiting.
 */
export class Approvals {
  private waiting = new Map<
    string,
    { kind: ApprovalAsk["kind"]; done: (allow: boolean) => void; memberId: string; title: string; at: number }
  >();

  /** What waits for your answer right now (for the pet and other places outside the thread). */
  pending(): { id: string; kind: ApprovalAsk["kind"]; memberId: string; title: string; at: number }[] {
    return [...this.waiting].map(([id, w]) => ({ id, kind: w.kind, memberId: w.memberId, title: w.title, at: w.at }));
  }
  private always = new Set<ApprovalAsk["kind"]>();

  constructor(
    private mode: ApprovalMode,
    private emit: (e: RunEvent) => void,
  ) {}

  /** True when this kind goes through without asking. */
  free(kind: ApprovalAsk["kind"]): boolean {
    if (this.mode === "all" || this.always.has(kind)) return true;
    return this.mode === "edits" && kind !== "tool";
  }

  ask(memberId: string, a: ApprovalAsk): Promise<boolean> {
    if (this.free(a.kind)) return Promise.resolve(true);
    const id = randomUUID();
    return new Promise<boolean>((done) => {
      this.waiting.set(id, { kind: a.kind, done, memberId, title: a.title.slice(0, 300), at: Date.now() });
      this.emit({
        type: "approval.request",
        id,
        memberId,
        kind: a.kind,
        title: a.title.slice(0, 300),
        ...(a.detail ? { detail: a.detail.slice(0, 20_000) } : {}),
        ...(a.files?.length ? { files: a.files.slice(0, 50) } : {}),
      });
    });
  }

  /** Your answer. With `always`, the same kind isn't asked again in this run. */
  resolve(id: string, allow: boolean, always = false): boolean {
    const item = this.waiting.get(id);
    if (!item) return false;
    this.settle(id, allow, always && allow);
    if (allow && always) {
      this.always.add(item.kind);
      // Other requests of that kind already waiting go through too.
      for (const [other, w] of [...this.waiting])
        if (w.kind === item.kind) this.settle(other, true);
    }
    return true;
  }

  declineAll(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, false);
  }

  private settle(id: string, allow: boolean, always = false) {
    const item = this.waiting.get(id);
    if (!item) return;
    this.waiting.delete(id);
    this.emit({ type: "approval.resolved", id, allow, ...(always ? { always } : {}) });
    item.done(allow);
  }
}
