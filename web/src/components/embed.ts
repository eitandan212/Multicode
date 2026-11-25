import { createContext, useContext } from "react";

/** True when a dialog is shown inside the Settings page instead of on its own. */
export const EmbeddedContext = createContext(false);

/** Opens a settings dialog: modal on its own, inline (non-modal) inside the Settings page. */
export function useOpenDialog(): (d: HTMLDialogElement | null) => void {
  const embedded = useContext(EmbeddedContext);
  return (d) => {
    if (!d || d.open) return;
    if (embedded) d.show();
    else d.showModal();
  };
}
