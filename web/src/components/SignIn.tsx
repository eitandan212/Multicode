import { useState } from "react";
import { api, type AccountUser } from "../api";
import { Icon, Spinner } from "./Icon";
import { Lockup } from "./Logo";

/** Google sign-in: opens Google, then waits until it answers (up to five minutes). */
export async function signInWithGoogle(): Promise<AccountUser> {
  const { url, state } = await api.googleStart();
  window.open(url, "_blank", "noopener");
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await api.googlePoll(state);
    if (r.done) {
      if ("error" in r && r.error) throw new Error(r.error);
      if ("user" in r && r.user) return r.user;
    }
  }
  throw new Error("Google didn't answer in time. Try again.");
}

const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.6 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

/** The sign-in screen; the first time, it makes the owner's account. */
export function SignIn({ setup, google, onDone }: { setup: boolean; google: boolean; onDone: (u: AccountUser) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"" | "form" | "google">("");
  const [error, setError] = useState("");

  const go = async (kind: "form" | "google") => {
    setBusy(kind);
    setError("");
    try {
      onDone(
        kind === "google"
          ? await signInWithGoogle()
          : setup
            ? await api.authSetup({ name, email, password })
            : await api.authLogin(email, password),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={(e) => {
          e.preventDefault();
          void go("form");
        }}
      >
        <Lockup size={26} />
        <h1>{setup ? "Create your account" : "Welcome back"}</h1>
        <p className="muted">
          {setup
            ? "This is the owner's account. From now on MultiCode asks for it, and you can add people later in Settings."
            : "Sign in to keep working."}
        </p>
        {google && (
          <>
            <button type="button" className="btn signin-google" onClick={() => void go("google")} disabled={busy !== ""}>
              {busy === "google" ? <Spinner /> : <GoogleMark />} Continue with Google
            </button>
            <span className="signin-or muted small">or</span>
          </>
        )}
        {setup && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 8 : undefined}
            required
          />
          {setup && <span className="muted small">At least 8 characters.</span>}
        </label>
        {error && <p className="err-text small">{error}</p>}
        <button className="btn primary signin-submit" disabled={busy !== "" || !email || !password}>
          {busy === "form" ? <Spinner /> : <Icon name={setup ? "check" : "arrowUp"} size={14} />}
          {setup ? "Create account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
