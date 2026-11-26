import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pet } from "./components/Pet";
import { AuthGate } from "./components/AuthGate";
import { applyAppearance, loadAppearance } from "./appearance";
import { installDialogExit, installSegPills } from "./motion";
import { installWindowChrome } from "./windowChrome";
import "./styles.css";

// Apply the saved look before the first paint.
applyAppearance(loadAppearance());
installWindowChrome();
installDialogExit();
installSegPills();

// The desktop pet's window loads the same page with ?pet=1 and shows only the pet.
const petWindow = new URLSearchParams(location.search).get("pet") === "1";
if (petWindow) document.documentElement.classList.add("pet-window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {petWindow ? (
      <AuthGate quiet>
        <Pet standalone onOpen={(id) => window.multicodeDesktop?.openRun?.(id)} />
      </AuthGate>
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);
