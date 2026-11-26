// Your own skills, in the Agent Skills format: a folder with SKILL.md (front matter with name and
// description, then instructions). Write one in Settings, install one from GitHub, or ask in chat
// ("install the skill from <url>"). They reach every harness and every API agent.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./config.js";
import type { Skill } from "./skills.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_BYTES = 64 * 1024;

export function skillName(raw: unknown): string {
  const n = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "") : "";
  if (!NAME.test(n)) throw new HttpError(400, "A skill name uses letters, digits and dashes (up to 48)");
  return n;
}

/** Name, description and instructions from a SKILL.md. */
export function parseSkill(text: string, fallbackName?: string): Skill {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = fm?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(meta)?.[1];
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  const name = skillName(field("name") ?? fallbackName ?? "");
  const description = (field("description") ?? body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "").slice(0, 300);
  if (!body) throw new HttpError(400, "The skill has no instructions");
  return { name, description, body };
}

export class CustomSkills {
  constructor(private dir: string) {}

  async list(): Promise<Skill[]> {
    const out: Skill[] = [];
    for (const e of await readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !NAME.test(e.name)) continue;
      const text = await readFile(path.join(this.dir, e.name, "SKILL.md"), "utf8").catch(() => undefined);
      if (!text) continue;
      try {
        out.push({ ...parseSkill(text, e.name), name: e.name });
      } catch {
        /* skip a broken file */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(input: { name?: unknown; description?: unknown; body?: unknown }): Promise<Skill> {
    const name = skillName(input.name);
    const description = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw new HttpError(400, "Write the skill's instructions");
    if (Buffer.byteLength(body) > MAX_BYTES) throw new HttpError(413, "The skill is too long (64 KB at most)");
    await mkdir(path.join(this.dir, name), { recursive: true });
    const md = `---\nname: ${name}\ndescription: ${JSON.stringify(description || name)}\n---\n\n${body}\n`;
    await writeFile(path.join(this.dir, name, "SKILL.md"), md);
    return { name, description: description || name, body };
  }

  async remove(name: unknown): Promise<void> {
    await rm(path.join(this.dir, skillName(name)), { recursive: true, force: true });
  }

  /** Installs a SKILL.md from GitHub (a file, a folder or a raw link) or any https address. */
  async install(url: unknown, fetcher: typeof fetch = fetch): Promise<Skill> {
    const raw = rawUrl(url);
    const res = await fetcher(raw, { redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
      throw new HttpError(400, `Couldn't download the skill: ${e.message}`);
    });
    if (!res.ok) throw new HttpError(400, `Couldn't download the skill (${res.status}). Check the address.`);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new HttpError(413, "That skill is too long (64 KB at most)");
    if (/^\s*<(!doctype|html)/i.test(text)) throw new HttpError(400, "That address is a web page, not a SKILL.md file");
    const guess = raw.split("/").slice(-2, -1)[0];
    const skill = parseSkill(text, guess);
    return this.save(skill);
  }
}

/** A GitHub page address → the raw SKILL.md file; other https addresses are used as they are. */
export function rawUrl(input: unknown): string {
  const u = typeof input === "string" ? input.trim() : "";
  if (!/^https:\/\/[\w.-]+\//.test(u)) throw new HttpError(400, "Paste an https address of a SKILL.md (a GitHub link works)");
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|tree)\/([^/]+)\/(.+?)\/?$/.exec(u);
  if (gh) {
    const file = gh[4]!.endsWith(".md") ? gh[4] : `${gh[4]}/SKILL.md`;
    return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${file}`;
  }
  return u;
}

/** "install the skill from <url>" (in English or Hebrew) → the url. */
export function installRequest(prompt: string): string | undefined {
  const m = /^(?:please\s+)?(?:install|add|תתקין|התקן|תוסיף)\s+(?:the\s+|a\s+|את\s+)?(?:skill|סקיל|הסקיל)\s+(?:from\s+|מ-?\s*)?(https:\/\/\S+)\s*$/i.exec(prompt.trim());
  return m?.[1];
}
