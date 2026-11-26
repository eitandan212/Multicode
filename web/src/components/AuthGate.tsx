import { createContext, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type AccountUser } from "../api";
import { SignIn } from "./SignIn";

/** The signed-in person (null when MultiCode has no accounts yet). */
export const CurrentUser = createContext<{ user: AccountUser | null; refresh: () => void }>({ user: null, refresh: () => {} });

/**
 * Shows the app only to someone signed in, once MultiCode has accounts. The first time, it asks
 * to create the owner's account. `quiet` (the pet's window) shows nothing instead of the form.
 */
export function AuthGate({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.authStatus>> | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    api.authStatus().then(
      (s) => {
        setStatus(s);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("multicode:signin", refresh);
    return () => window.removeEventListener("multicode:signin", refresh);
  }, [refresh]);

  if (error) return quiet ? null : <p className="muted signin-error">Couldn't reach MultiCode: {error}</p>;
  if (!status) return null;
  const needs = status.setup || (status.required && !status.user);
  if (needs) return quiet ? null : <SignIn setup={status.setup} google={status.google} onDone={() => refresh()} />;
  return <CurrentUser.Provider value={{ user: status.user, refresh }}>{children}</CurrentUser.Provider>;
}
