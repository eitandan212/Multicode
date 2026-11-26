// The in-app browser: a real browser view inside MultiCode's window (desktop app) that the crew
// drives through an MCP server MultiCode serves itself, at /mcp/browser. You watch every step
// live in the Browser tab, and can browse in it yourself. The desktop app registers the driver;
// without it (MultiCode in a web browser) agents use the headless Playwright browser instead.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** What the desktop app gives MultiCode to drive its browser view. */
export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  /** Runs a script in the page (MultiCode's own helpers only; agents get no free script access). */
  evaluate<T>(script: string): Promise<T>;
  /** A real mouse click at page coordinates (CSS pixels). */
  click(x: number, y: number): Promise<void>;
  /** Types text into the focused element. */
  type(text: string): Promise<void>;
  /** One key press: "Enter", "Tab", "Escape", "ArrowDown", "Backspace"… */
  key(name: string): Promise<void>;
  scroll(dy: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** The latest console messages ("error: …", "warning: …", "log: …"). */
  console(): string[];
  state(): { url: string; title: string };
  /** Brings the Browser tab into view so you can watch. */
  reveal(): void;
}

let driver: BrowserDriver | null = null;
// Agents reach /mcp/browser with this key in the URL (they can't sign in). New every start.
const KEY = randomBytes(24).toString("hex");

/**
 * The built-in browser has its own storage, so it isn't signed in: this pass (a cookie MultiCode
 * sets there) lets it see the project previews, and nothing else. New every start.
 */
export const PREVIEW_PASS_COOKIE = "mc_preview";
const PREVIEW_PASS = randomBytes(24).toString("hex");
export function previewPass(): string {
  return PREVIEW_PASS;
}
export function validPreviewPass(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length !== PREVIEW_PASS.length) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(PREVIEW_PASS));
}

export function registerBrowserDriver(d: BrowserDriver | null): void {
  driver = d;
}
export function hasBrowserDriver(): boolean {
  return driver !== null;
}
/** The address agents use, when the in-app browser exists. */
export function browserMcpUrl(origin: string): string | undefined {
  return driver ? `${origin.replace(/\/$/, "")}/mcp/browser?key=${KEY}` : undefined;
}
export function validBrowserKey(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length !== KEY.length) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(KEY));
}

const ALLOWED = /^(https?:|about:blank$)/i;
const MAX_TEXT = 6000;

// Marks the visible elements you can act on with data-mc-ref and lists them, with the page text.
const SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3; };
  document.querySelectorAll("[data-mc-ref]").forEach((el) => el.removeAttribute("data-mc-ref"));
  const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=true], [onclick]";
  const items = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 150) continue;
    const ref = "e" + (++n); el.setAttribute("data-mc-ref", ref);
    const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const kind = el.tagName.toLowerCase() + (el.type && el.tagName === "INPUT" ? "[" + el.type + "]" : "");
    items.push("[" + ref + "] " + kind + (label ? ' "' + label + '"' : "") + (el.tagName === "A" && el.href ? " -> " + el.href.slice(0, 120) : ""));
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { title: document.title, url: location.href, items, text };
})()`;
const AT = (ref: string) => `(() => {
  const el = document.querySelector('[data-mc-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
const FOCUS_CLEAR = (ref: string) => `(() => {
  const el = document.querySelector('[data-mc-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return false;
  el.focus();
  if ("value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
  else if (el.isContentEditable) el.textContent = "";
  return true;
})()`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where agents may take the browser: the MultiCode preview only, unless you allowed any website. */
export interface BrowserPolicy {
  anyWebsite: boolean;
  /** e.g. http://localhost:4317 */
  origin: string;
}
export function allowedForAgents(url: string, p: BrowserPolicy): boolean {
  if (!ALLOWED.test(url)) return false;
  if (p.anyWebsite || url === "about:blank") return true;
  try {
    const u = new URL(url);
    const o = new URL(p.origin);
    return u.port === o.port && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

function tools(server: McpServer, d: BrowserDriver, policy: BrowserPolicy) {
  const where = () => {
    const s = d.state();
    return `Now at ${s.url}${s.title ? ` (${s.title})` : ""}.`;
  };
  server.registerTool(
    "browser_navigate",
    {
      description: "Open a web address in MultiCode's browser (the user watches it in the Browser tab).",
      inputSchema: { url: z.string().describe("Full address, e.g. http://localhost:4317/preview/my-app/") },
    },
    async ({ url }) => {
      if (!allowedForAgents(url, policy))
        return fail(
          policy.anyWebsite
            ? "Only http(s) addresses can be opened."
            : `Only the MultiCode preview (${policy.origin}/preview/…) is allowed. The user can allow any website in Settings > Plugins.`,
        );
      d.reveal();
      await d.navigate(url);
      return text(`${where()} Call browser_snapshot to see the page.`);
    },
  );
  server.registerTool(
    "browser_snapshot",
    {
      description:
        "The page as text: its title, address, visible text, and the elements you can act on, each with a ref (e1, e2…) for browser_click and browser_type.",
    },
    async () => {
      const s = await d.evaluate<{ title: string; url: string; items: string[]; text: string }>(SNAPSHOT);
      return text(
        [
          `${s.title || "(no title)"} — ${s.url}`,
          s.items.length ? `Elements:\n${s.items.join("\n")}` : "No clickable elements visible.",
          `Text:\n${s.text.slice(0, MAX_TEXT)}${s.text.length > MAX_TEXT ? "\n…" : ""}`,
        ].join("\n\n"),
      );
    },
  );
  server.registerTool(
    "browser_click",
    { description: "Click an element by its ref from browser_snapshot.", inputSchema: { ref: z.string() } },
    async ({ ref }) => {
      const at = await d.evaluate<{ x: number; y: number } | null>(AT(ref));
      if (!at) return fail(`No element ${ref}: take a new browser_snapshot.`);
      d.reveal();
      await wait(120);
      await d.click(at.x, at.y);
      await wait(400);
      return text(`Clicked ${ref}. ${where()}`);
    },
  );
  server.registerTool(
    "browser_type",
    {
      description: "Type into a field (its ref from browser_snapshot); it replaces what's there. submit: press Enter after.",
      inputSchema: { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
    },
    async ({ ref, text: value, submit }) => {
      if (!(await d.evaluate<boolean>(FOCUS_CLEAR(ref)))) return fail(`No element ${ref}: take a new browser_snapshot.`);
      d.reveal();
      await d.type(value);
      if (submit) {
        await d.key("Enter");
        await wait(500);
      }
      return text(`Typed into ${ref}${submit ? " and pressed Enter" : ""}. ${where()}`);
    },
  );
  server.registerTool(
    "browser_press_key",
    { description: 'Press one key, e.g. "Enter", "Escape", "Tab", "ArrowDown".', inputSchema: { key: z.string() } },
    async ({ key }) => {
      await d.key(key);
      return text(`Pressed ${key}.`);
    },
  );
  server.registerTool(
    "browser_scroll",
    { description: "Scroll the page.", inputSchema: { direction: z.enum(["up", "down"]) } },
    async ({ direction }) => {
      await d.scroll(direction === "down" ? 600 : -600);
      return text(`Scrolled ${direction}.`);
    },
  );
  server.registerTool("browser_back", { description: "Go back one page." }, async () => {
    await d.back();
    return text(where());
  });
  server.registerTool("browser_screenshot", { description: "A picture of what the browser shows now." }, async () => {
    const png = await d.screenshot();
    if (png.length < 200) return fail("The Browser tab is out of view, so there's no picture right now; use browser_snapshot.");
    return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
  });
  server.registerTool(
    "browser_console",
    { description: "The page's latest console messages (errors first look here)." },
    async () => {
      const lines = d.console();
      return text(lines.length ? lines.slice(-60).join("\n") : "The console is empty.");
    },
  );
}

/** POST/GET/DELETE /mcp/browser: one stateless MCP exchange per request. */
export async function handleBrowserMcp(req: Request, res: Response, policy: BrowserPolicy): Promise<void> {
  if (!validBrowserKey(req.query.key)) {
    res.status(401).json({ error: "bad key" });
    return;
  }
  if (!driver) {
    res.status(503).json({ error: "The in-app browser is only in the MultiCode desktop app" });
    return;
  }
  if (req.method !== "POST") {
    // Stateless: no standing event stream to open or session to end.
    res.status(405).set("Allow", "POST").end();
    return;
  }
  const server = new McpServer({ name: "multicode-browser", version: "1.0.0" });
  tools(server, driver, policy);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
