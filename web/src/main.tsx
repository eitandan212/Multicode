import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./appearance";
import { installDialogExit, installSegPills } from "./motion";
import { installWindowChrome } from "./windowChrome";
import "./styles.css";

// Apply the saved look before the first paint.
applyAppearance(loadAppearance());
installWindowChrome();
installDialogExit();
installSegPills();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
