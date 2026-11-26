import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Todos } from "../server/todos.js";

describe("Todos", () => {
  const fresh = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-todos-"));
    return { file: path.join(dir, "todos.json"), todos: new Todos(path.join(dir, "todos.json")) };
  };

  it("adds, ticks, edits, deletes and persists", async () => {
    const { file, todos } = await fresh();
    const a = await todos.add({ text: "  Write   tests ", project: "app" });
    const b = await todos.add({ text: "General thing", project: null });
    expect(a.text).toBe("Write tests");
    await todos.update(a.id, { done: true });
    expect((await todos.list()).map((t) => t.id)).toEqual([b.id, a.id]); // open first
    expect((await todos.list("app")).map((t) => t.id)).toEqual([a.id]);
    expect((await todos.list(null)).map((t) => t.id)).toEqual([b.id]);
    await todos.update(b.id, { text: "Renamed" });
    await todos.remove(a.id);
    const saved = JSON.parse(await readFile(file, "utf8")) as { text: string }[];
    expect(saved.map((t) => t.text)).toEqual(["Renamed"]);
    expect(await new Todos(file).list()).toHaveLength(1);
  });

  it("rejects empty text and unknown ids", async () => {
    const { todos } = await fresh();
    await expect(todos.add({ text: "   " })).rejects.toThrow(/Write the to-do/);
    await expect(todos.update("nope", { done: true })).rejects.toThrow(/No such/);
  });

  it("ticks itself once its chat is done, and keeps parallel edits", async () => {
    const { todos } = await fresh();
    const t = await todos.add({ text: "Ship it" });
    await todos.update(t.id, { runId: "run-1" });
    expect((await todos.list(undefined, () => false))[0]!.done).toBe(false);
    expect((await todos.list(undefined, (id) => id === "run-1"))[0]!.done).toBe(true);
    await Promise.all(Array.from({ length: 20 }, (_, i) => todos.add({ text: `n${i}` })));
    expect(await todos.list()).toHaveLength(21);
  });
});
