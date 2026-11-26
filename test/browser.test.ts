import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { ConfigStore } from "../server/config.js";
import { allowedForAgents, browserMcpUrl, registerBrowserDriver, type BrowserDriver } from "../server/inAppBrowser.js";
import { pluginContributions } from "../server/plugins.js";

describe("in-app browser (MCP)", () => {
  let base: string;
  let close: () => void;
  let dir: string;
  const did: string[] = [];
  let url = "about:blank";
  const driver: BrowserDriver = {
    async navigate(u) {
      url = u;
      did.push(`go ${u}`);
    },
    async back() {
      did.push("back");
    },
    async evaluate<T>(script: string) {
      if (script.includes("data-mc-ref") && script.includes("items"))
        return { title: "My app", url, items: ['[e1] button "Sign up"', '[e2] input[email] "Email"'], text: "Welcome" } as T;
      if (script.includes("scrollIntoView")) return (script.includes('"e1"') ? { x: 40, y: 60 } : null) as T;
      if (script.includes("focus()")) return true as T;
      return undefined as T;
    },
    async click(x, y) {
      did.push(`click ${x},${y}`);
    },
    async type(t) {
      did.push(`type ${t}`);
    },
    async key(k) {
      did.push(`key ${k}`);
    },
    async scroll(dy) {
      did.push(`scroll ${dy}`);
    },
    async screenshot() {
      return Buffer.alloc(1000, 1);
    },
    console: () => ["error: boom"],
    state: () => ({ url, title: "My app" }),
    reveal: () => void did.push("reveal"),
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mc-browser-"));
    const config = new ConfigStore(dir);
    await config.load();
    const { app } = createApp({ config, projectsDir: path.join(dir, "projects"), providerFactory: () => ({ editsFiles: false, generate: async () => "" }) });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(async () => {
    registerBrowserDriver(null);
    close();
    await rm(dir, { recursive: true, force: true });
  });

  it("exists only in the desktop app, and only with its key", async () => {
    registerBrowserDriver(null);
    expect(browserMcpUrl(base)).toBeUndefined();
    registerBrowserDriver(driver);
    const mcp = browserMcpUrl(base)!;
    expect(mcp).toMatch(/\/mcp\/browser\?key=[0-9a-f]{48}$/);
    const bad = await fetch(`${base}/mcp/browser?key=nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    // The crew's browser plugin points at it instead of a headless browser.
    const c = pluginContributions({ enabled: ["browser"], disabled: [] }, { project: "p", dataDir: dir, previewOrigin: base, inAppBrowser: mcp, options: {} });
    expect(c.servers.find((s) => s.name === "browser")).toMatchObject({ type: "http", url: mcp });
  });

  it("lets an agent open the preview, read it, click and type, but not leave the preview", async () => {
    registerBrowserDriver(driver);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(browserMcpUrl(base)!)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "browser_console"]));

    const text = (r: unknown) => ((r as { content: { text?: string }[] }).content[0]?.text ?? "");
    const away = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });
    expect(away.isError).toBe(true);
    expect(text(away)).toMatch(/Only the MultiCode preview/);

    await client.callTool({ name: "browser_navigate", arguments: { url: `${base}/preview/p/` } });
    expect(did).toContain(`go ${base}/preview/p/`);
    expect(did).toContain("reveal");
    expect(text(await client.callTool({ name: "browser_snapshot", arguments: {} }))).toMatch(/\[e1\] button "Sign up"[\s\S]*Welcome/);
    expect(text(await client.callTool({ name: "browser_click", arguments: { ref: "e1" } }))).toMatch(/Clicked e1/);
    expect(did).toContain("click 40,60");
    expect((await client.callTool({ name: "browser_click", arguments: { ref: "e9" } })).isError).toBe(true);
    await client.callTool({ name: "browser_type", arguments: { ref: "e2", text: "a@b.c", submit: true } });
    expect(did).toEqual(expect.arrayContaining(["type a@b.c", "key Enter"]));
    expect(text(await client.callTool({ name: "browser_console", arguments: {} }))).toBe("error: boom");
    const shot = (await client.callTool({ name: "browser_screenshot", arguments: {} })) as { content: { type: string; mimeType?: string }[] };
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    await client.close();
  });

  it("keeps agents on the preview unless any website is allowed", () => {
    const p = { anyWebsite: false, origin: "http://localhost:4317" };
    expect(allowedForAgents("http://localhost:4317/preview/x/", p)).toBe(true);
    expect(allowedForAgents("http://127.0.0.1:4317/preview/x/", p)).toBe(true);
    expect(allowedForAgents("http://localhost:9999/", p)).toBe(false);
    expect(allowedForAgents("https://evil.example/", p)).toBe(false);
    expect(allowedForAgents("file:///etc/passwd", { ...p, anyWebsite: true })).toBe(false);
    expect(allowedForAgents("https://example.com/", { ...p, anyWebsite: true })).toBe(true);
  });
});
