import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanScripts, ScriptRunner, suggestScripts } from "../server/scripts.js";

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

describe("project scripts", () => {
  it("cleans names, commands and ids", () => {
    expect(cleanScripts([{ name: " Dev  server ", command: "npm run dev" }, { name: "Dev server", command: "x" }])).toEqual([
      { id: "dev-server", name: "Dev server", command: "npm run dev" },
      { id: "dev-server-2", name: "Dev server", command: "x" },
    ]);
    expect(() => cleanScripts([{ name: "a", command: "one\ntwo" }])).toThrow(/one line/);
    expect(() => cleanScripts([{ name: "", command: "x" }])).toThrow(/name/);
  });

  it("suggests package.json scripts with the project's runner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-scripts-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", dev: "vite", postinstall: "x" } }));
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    expect(await suggestScripts(dir)).toEqual([
      { id: "dev", name: "Dev", command: "pnpm run dev" },
      { id: "test", name: "Test", command: "pnpm test" },
    ]);
  });

  it("runs, streams output, finds a local address and stops", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-run-"));
    const r = new ScriptRunner();
    r.start("p", dir, { id: "ok", name: "ok", command: "echo hello && echo 'ready on http://localhost:5173/'" });
    await until(() => r.state("p", "ok").status !== "running");
    const s = r.state("p", "ok");
    expect(s.status).toBe("done");
    expect(s.lines).toContain("hello");
    expect(s.url).toBe("http://localhost:5173/");
    expect(r.state("p", "ok", s.total).lines).toEqual([]);

    r.start("p", dir, { id: "long", name: "long", command: "sleep 30" });
    expect(r.running("p")).toEqual(["long"]);
    expect(() => r.start("p", dir, { id: "long", name: "long", command: "sleep 30" })).toThrow(/already running/);
    r.stop("p", "long");
    await until(() => r.state("p", "long").status !== "running");
    expect(r.state("p", "long").status).toBe("stopped");

    r.start("p", dir, { id: "bad", name: "bad", command: "exit 3" });
    await until(() => r.state("p", "bad").status !== "running");
    expect(r.state("p", "bad")).toMatchObject({ status: "failed", exitCode: 3 });
  });
});
