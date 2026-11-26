// Secret values at rest (API keys, extra headers, MCP secrets, OAuth client secrets) are
// encrypted with AES-256-GCM. The key comes from the OS keychain in the desktop app (Electron
// safeStorage passes it in MULTICODE_SECRET_KEY), or from a key file only you can read.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFIX = "enc:v1:";
let key: Buffer | undefined;

/** Loads (or creates) the encryption key. Call once before reading secrets. */
export async function loadSecretKey(dir: string): Promise<void> {
  const fromEnv = process.env.MULTICODE_SECRET_KEY;
  // Agents started later inherit this process's environment: the key must not travel with it.
  delete process.env.MULTICODE_SECRET_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv, "base64");
    if (k.length === 32) {
      key = k;
      return;
    }
  }
  const file = path.join(dir, "secret.key");
  try {
    const k = Buffer.from((await readFile(file, "utf8")).trim(), "base64");
    if (k.length === 32) {
      key = k;
      return;
    }
  } catch {
    /* first run: make one */
  }
  key = randomBytes(32);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, key.toString("base64"), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

/** For tests: use this key. */
export function useSecretKey(k: Buffer | undefined): void {
  key = k;
}

export const isEncrypted = (v: unknown): boolean => typeof v === "string" && v.startsWith(PREFIX);

export function encrypt(plain: string): string {
  if (!key || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

/** Plain text back; a value that isn't encrypted is returned as it is (older configs). */
export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;
  if (!key) throw new Error("The encryption key is missing, so saved secrets can't be read.");
  const [iv, tag, body] = value.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
  d.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(body!, "base64")), d.final()]).toString("utf8");
}

/** Every string value of a record, encrypted or decrypted. */
export function mapValues(rec: Record<string, string> | undefined, fn: (v: string) => string): Record<string, string> | undefined {
  return rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fn(v)])) : rec;
}
