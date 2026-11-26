// Accounts: once a first account exists, MultiCode asks everyone to sign in. Passwords are
// hashed with scrypt; sessions are random tokens in an HttpOnly cookie, stored only as hashes.
// Google sign-in works when you add a Google OAuth client (desktop type) in Settings > Account.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./config.js";
import { decrypt, encrypt } from "./secrets.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "mc_session";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
  /** scrypt$<salt>$<hash>; absent for Google-only accounts. */
  password?: string;
  google?: string;
  createdAt: number;
}
export type UserView = Omit<User, "password" | "google"> & { hasPassword: boolean; google: boolean };

interface Session {
  hash: string;
  userId: string;
  expires: number;
}

interface Store {
  users: User[];
  sessions: Session[];
  google?: { clientId: string; clientSecret?: string };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

export const viewOf = (u: User): UserView => {
  const { password, google, ...rest } = u;
  return { ...rest, hasPassword: Boolean(password), google: Boolean(google) };
};

export class Auth {
  private store: Store = { users: [], sessions: [] };
  private file: string;
  private writing = Promise.resolve();
  /** Failed sign-ins per email, to slow down guessing. */
  private failures = new Map<string, { n: number; until: number }>();
  /** Google sign-ins in progress: state → PKCE verifier, and the result once Google answers. */
  private googleFlows = new Map<string, { verifier: string; redirect: string; created: number; userId?: string; error?: string }>();

  constructor(dir: string) {
    this.file = path.join(dir, "users.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<Store>;
      this.store = {
        users: Array.isArray(raw.users) ? raw.users : [],
        sessions: (Array.isArray(raw.sessions) ? raw.sessions : []).filter((s) => s.expires > Date.now()),
        ...(raw.google?.clientId
          ? { google: { clientId: raw.google.clientId, ...(raw.google.clientSecret ? { clientSecret: decrypt(raw.google.clientSecret) } : {}) } }
          : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        ...this.store,
        ...(this.store.google
          ? { google: { ...this.store.google, ...(this.store.google.clientSecret ? { clientSecret: encrypt(this.store.google.clientSecret) } : {}) } }
          : {}),
      },
      null,
      2,
    );
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    });
    return this.writing;
  }

  /** Sign-in is required once there is at least one account. */
  get required(): boolean {
    return this.store.users.length > 0;
  }
  get googleReady(): boolean {
    return Boolean(this.store.google?.clientId);
  }
  users(): UserView[] {
    return this.store.users.map(viewOf);
  }

  private async hash(pw: string): Promise<string> {
    const salt = randomBytes(16);
    const h = await scrypt(pw, salt, 32, SCRYPT);
    return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
  }
  private async check(pw: string, stored: string): Promise<boolean> {
    const [, salt, hash] = stored.split("$");
    if (!salt || !hash) return false;
    const h = await scrypt(pw, Buffer.from(salt, "base64"), 32, SCRYPT);
    const want = Buffer.from(hash, "base64");
    return want.length === h.length && timingSafeEqual(want, h);
  }

  private validPassword(pw: unknown): string {
    if (typeof pw !== "string" || pw.length < 8) throw new HttpError(400, "Use a password of at least 8 characters");
    if (pw.length > 200) throw new HttpError(400, "That password is too long");
    return pw;
  }

  /** Adds an account. The first one is the owner and needs no session; later ones need the owner. */
  async addUser(input: { name?: unknown; email?: unknown; password?: unknown }, by?: User): Promise<User> {
    if (this.required && by?.role !== "owner") throw new HttpError(403, "Only the owner can add people");
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email");
    if (this.store.users.some((u) => u.email === email)) throw new HttpError(409, "There's already an account with that email");
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : email.split("@")[0]!;
    // People added by the owner may sign in with Google only (no password).
    const password = input.password === undefined && this.required ? undefined : await this.hash(this.validPassword(input.password));
    const user: User = { id: randomUUID(), name, email, role: this.required ? "member" : "owner", ...(password ? { password } : {}), createdAt: Date.now() };
    this.store.users.push(user);
    await this.save();
    return user;
  }

  async removeUser(id: string, by: User): Promise<void> {
    if (by.role !== "owner") throw new HttpError(403, "Only the owner can remove people");
    if (id === by.id) throw new HttpError(400, "You can't remove your own account");
    this.store.users = this.store.users.filter((u) => u.id !== id);
    this.store.sessions = this.store.sessions.filter((s) => s.userId !== id);
    await this.save();
  }

  async changePassword(user: User, current: unknown, next: unknown): Promise<void> {
    if (user.password && !(typeof current === "string" && (await this.check(current, user.password))))
      throw new HttpError(400, "The current password isn't right");
    user.password = await this.hash(this.validPassword(next));
    // Other devices sign in again.
    this.store.sessions = this.store.sessions.filter((s) => s.userId !== user.id);
    await this.save();
  }

  /** Email and password → a new session token (set as a cookie by the caller). */
  async signIn(emailIn: unknown, password: unknown): Promise<{ token: string; user: User }> {
    const email = typeof emailIn === "string" ? emailIn.trim().toLowerCase() : "";
    const f = this.failures.get(email);
    if (f && f.until > Date.now()) throw new HttpError(429, "Too many tries. Wait a few minutes, then try again.");
    const user = this.store.users.find((u) => u.email === email);
    const ok = user?.password && typeof password === "string" && (await this.check(password, user.password));
    if (!ok || !user) {
      const n = (f?.n ?? 0) + 1;
      this.failures.set(email, { n, until: n >= 8 ? Date.now() + 10 * 60_000 : 0 });
      throw new HttpError(401, "Wrong email or password");
    }
    this.failures.delete(email);
    return { token: await this.newSession(user), user };
  }

  private async newSession(user: User): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    this.store.sessions.push({ hash: tokenHash(token), userId: user.id, expires: Date.now() + SESSION_DAYS * 86_400_000 });
    this.store.sessions = this.store.sessions.filter((s) => s.expires > Date.now()).slice(-200);
    await this.save();
    return token;
  }

  /** The signed-in user for a session token, if it's valid. */
  userFor(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const h = tokenHash(token);
    const s = this.store.sessions.find((x) => x.hash === h && x.expires > Date.now());
    return s ? this.store.users.find((u) => u.id === s.userId) : undefined;
  }

  async signOut(token: string | undefined): Promise<void> {
    if (!token) return;
    const h = tokenHash(token);
    this.store.sessions = this.store.sessions.filter((s) => s.hash !== h);
    await this.save();
  }

  // ---- Google ----

  async setGoogle(input: { clientId?: unknown; clientSecret?: unknown }, by: User | undefined): Promise<void> {
    if (this.required && by?.role !== "owner") throw new HttpError(403, "Only the owner can set up Google sign-in");
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    if (!clientId) {
      delete this.store.google;
    } else {
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new HttpError(400, "That isn't a Google OAuth client ID (…apps.googleusercontent.com)");
      const secret = typeof input.clientSecret === "string" && input.clientSecret.trim() ? input.clientSecret.trim() : this.store.google?.clientSecret;
      this.store.google = { clientId, ...(secret ? { clientSecret: secret } : {}) };
    }
    await this.save();
  }

  /** Starts a Google sign-in: the address to open, and the state to poll with. */
  googleStart(origin: string): { url: string; state: string } {
    const g = this.store.google;
    if (!g) throw new HttpError(400, "Google sign-in isn't set up. The owner adds a Google client in Settings > Account.");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect = `${origin}/api/auth/google/callback`;
    for (const [k, v] of this.googleFlows) if (Date.now() - v.created > 10 * 60_000) this.googleFlows.delete(k);
    this.googleFlows.set(state, { verifier, redirect, created: Date.now() });
    const q = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state };
  }

  /** Google sends the browser back here. Exchanges the code, checks the token, finds the account. */
  async googleCallback(state: unknown, code: unknown, fetcher: typeof fetch = fetch): Promise<void> {
    const flow = typeof state === "string" ? this.googleFlows.get(state) : undefined;
    if (!flow) throw new HttpError(400, "This sign-in expired. Start again from MultiCode.");
    const g = this.store.google!;
    try {
      if (typeof code !== "string" || !code) throw new Error("Google didn't send a code");
      const tokenRes = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: g.clientId,
          ...(g.clientSecret ? { client_secret: g.clientSecret } : {}),
          redirect_uri: flow.redirect,
          grant_type: "authorization_code",
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const tokens = (await tokenRes.json()) as { id_token?: string; error_description?: string };
      if (!tokenRes.ok || !tokens.id_token) throw new Error(tokens.error_description ?? "Google refused the sign-in");
      // Google checks the token's signature and expiry; we check it's for this app and verified.
      const infoRes = await fetcher(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const info = (await infoRes.json()) as { aud?: string; sub?: string; email?: string; email_verified?: string | boolean; name?: string };
      if (!infoRes.ok || info.aud !== g.clientId || !info.sub) throw new Error("Google's answer wasn't for this app");
      if (!(info.email_verified === true || info.email_verified === "true")) throw new Error("That Google account's email isn't verified");
      const email = (info.email ?? "").toLowerCase();
      let user = this.store.users.find((u) => u.google === info.sub) ?? this.store.users.find((u) => u.email === email);
      if (!user && !this.required) {
        // The very first account can be made with Google; it's the owner.
        user = { id: randomUUID(), name: info.name || email.split("@")[0]!, email, role: "owner", createdAt: Date.now() };
        this.store.users.push(user);
      }
      if (!user) throw new Error(`No MultiCode account for ${email}. Ask the owner to add you.`);
      user.google = info.sub;
      await this.save();
      flow.userId = user.id;
    } catch (err) {
      flow.error = (err as Error).message;
    }
  }

  /** The app polls until the Google sign-in it started is done: then it gets its own session. */
  async googlePoll(state: unknown): Promise<{ done: false } | { done: true; token: string; user: User } | { done: true; error: string }> {
    const flow = typeof state === "string" ? this.googleFlows.get(state) : undefined;
    if (!flow) throw new HttpError(404, "No sign-in in progress");
    if (flow.error) {
      this.googleFlows.delete(state as string);
      return { done: true, error: flow.error };
    }
    if (!flow.userId) return { done: false };
    this.googleFlows.delete(state as string);
    const user = this.store.users.find((u) => u.id === flow.userId)!;
    return { done: true, token: await this.newSession(user), user };
  }
}
