import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, loadAppearance } from "./appearance";
import { installDialogExit } from "./motion";
import "./styles.css";

// Apply the saved look before the first paint.
applyAppearance(loadAppearance());
installDialogExit();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
