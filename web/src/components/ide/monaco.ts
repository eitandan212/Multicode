// Monaco (the editor inside VS Code), bundled locally: no CDN, so the desktop app works offline.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

/** Reads one of MultiCode's CSS colour tokens as #rrggbb (Monaco wants hex). */
function token(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(rgb);
  if (!m) return fallback;
  const hex = [m[1], m[2], m[3]]
    .map((n) => Number(n).toString(16).padStart(2, "0"))
    .join("");
  const alpha =
    m[4] !== undefined
      ? Math.round(Number(m[4]) * 255)
          .toString(16)
          .padStart(2, "0")
      : "";
  return `#${hex}${alpha}`;
}

export function isDark(): boolean {
  return getComputedStyle(document.documentElement).colorScheme.includes(
    "dark",
  );
}

/** Builds the MultiCode theme from the live app colours (so custom accents carry over). */
export function applyTheme(): void {
  const dark = isDark();
  monaco.editor.defineTheme("multicode", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": token("--card", dark ? "#15161a" : "#ffffff"),
      "editor.foreground": token("--text", dark ? "#f5f4ef" : "#0b0c0f"),
      "editorLineNumber.foreground": token("--muted", "#71717a"),
      "editorLineNumber.activeForeground": token(
        "--text",
        dark ? "#f5f4ef" : "#0b0c0f",
      ),
      "editor.lineHighlightBackground": dark ? "#ffffff08" : "#0000000a",
      "editor.selectionBackground": dark ? "#2563ff55" : "#2563ff33",
      "editorCursor.foreground": token("--focus", "#2563ff"),
      "editorWidget.background": token("--card", dark ? "#15161a" : "#ffffff"),
      "editorWidget.border": dark ? "#ffffff1a" : "#00000014",
      "editorIndentGuide.background1": dark ? "#ffffff10" : "#00000010",
      "scrollbarSlider.background": dark ? "#ffffff18" : "#00000018",
      "minimap.background": token("--card", dark ? "#15161a" : "#ffffff"),
    },
  });
  monaco.editor.setTheme("multicode");
}

export { monaco };
