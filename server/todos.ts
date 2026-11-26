// Your to-do list: short notes per project (or general), kept on this computer. The pet shows
// what's next, a to-do can be sent to the crew as a new chat, and it ticks itself once that
// chat finishes.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./config.js";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** The project it belongs to; null for a general to-do. */
  project: string | null;
  createdAt: number;
  doneAt?: number;
  /** The chat it was sent to, if any. */
  runId?: string;
}

const MAX_TODOS = 500;
const MAX_TEXT = 500;

function cleanText(raw: unknown): string {
  const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!t) throw new HttpError(400, "Write the to-do");
  return t.slice(0, MAX_TEXT);
}

function cleanProject(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 200) throw new HttpError(400, "Bad project");
  return raw;
}

export class Todos {
  private cache: Todo[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private file: string) {}

  private async load(): Promise<Todo[]> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      this.cache = Array.isArray(raw) ? (raw as Todo[]).filter((t) => t && typeof t.id === "string" && typeof t.text === "string") : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(list: Todo[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 1));
    await rename(tmp, this.file);
  }

  /** Changes run one at a time, so two quick edits never lose each other. */
  private change<T>(fn: (list: Todo[]) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const list = await this.load();
      const out = fn(list);
      await this.persist(list);
      return out;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Open ones first (oldest first), then done ones (newest first). */
  async list(project?: string | null, isRunDone?: (runId: string) => boolean): Promise<Todo[]> {
    let list = await this.load();
    // A to-do sent to the crew ticks itself once that chat is done.
    if (isRunDone && list.some((t) => !t.done && t.runId && isRunDone(t.runId)))
      list = await this.change((l) => {
        for (const t of l) if (!t.done && t.runId && isRunDone(t.runId)) Object.assign(t, { done: true, doneAt: Date.now() });
        return l;
      });
    const mine = project === undefined ? list : list.filter((t) => t.project === project);
    return [...mine].sort((a, b) =>
      a.done !== b.done ? (a.done ? 1 : -1) : a.done ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : a.createdAt - b.createdAt,
    );
  }

  async add(input: { text?: unknown; project?: unknown }): Promise<Todo> {
    const text = cleanText(input.text);
    const project = cleanProject(input.project);
    return this.change((list) => {
      if (list.length >= MAX_TODOS) {
        // Make room by dropping the oldest finished one; refuse if all are open.
        const i = list.findIndex((t) => t.done);
        if (i < 0) throw new HttpError(409, `The list is full (${MAX_TODOS} open to-dos)`);
        list.splice(i, 1);
      }
      const todo: Todo = { id: randomUUID(), text, done: false, project, createdAt: Date.now() };
      list.push(todo);
      return todo;
    });
  }

  update(id: string, patch: { text?: unknown; done?: unknown; runId?: unknown; project?: unknown }): Promise<Todo> {
    return this.change((list) => {
      const t = list.find((x) => x.id === id);
      if (!t) throw new HttpError(404, "No such to-do");
      if (patch.text !== undefined) t.text = cleanText(patch.text);
      if (patch.project !== undefined) t.project = cleanProject(patch.project);
      if (typeof patch.done === "boolean" && patch.done !== t.done) {
        t.done = patch.done;
        if (t.done) t.doneAt = Date.now();
        else delete t.doneAt;
      }
      if (typeof patch.runId === "string" && patch.runId.length <= 100) t.runId = patch.runId;
      return { ...t };
    });
  }

  remove(id: string): Promise<void> {
    return this.change((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /** Clears finished to-dos (of one project, or all). */
  clearDone(project?: string | null): Promise<number> {
    return this.change((list) => {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i--)
        if (list[i]!.done && (project === undefined || list[i]!.project === project)) list.splice(i, 1);
      return before - list.length;
    });
  }
}
