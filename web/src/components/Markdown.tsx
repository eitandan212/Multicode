import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

// Links from a model open outside the app, never in place of it.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** What a model wrote, as Markdown: headings, lists, tables, code. Sanitized: no scripts, no styles. */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
        FORBID_TAGS: ["style", "img", "form", "input", "button", "iframe"],
        FORBID_ATTR: ["style"],
      }),
    [text],
  );
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
