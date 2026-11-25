import { api } from "../api";

const ATTACHMENT = /@(\.attachments\/[0-9a-f]{8}\.(?:png|jpg|webp|gif))/g;

/** A one-line title for a message: attached pictures become a 🖼️. */
export function plainPrompt(text: string): string {
  const pics = text.match(ATTACHMENT)?.length ?? 0;
  const rest = text.replace(ATTACHMENT, "").replace(/\s+/g, " ").trim();
  return pics ? `🖼️ ${rest}`.trim() : rest;
}

/** A message as you wrote it, with attached pictures shown as thumbnails instead of their @path. */
export function PromptText({ text, project }: { text: string; project?: string }) {
  const pics = project ? [...text.matchAll(ATTACHMENT)].map((m) => m[1]!) : [];
  const rest = pics.length ? text.replace(ATTACHMENT, "").replace(/\s+$/, "") : text;
  return (
    <>
      {pics.length > 0 && (
        <span className="prompt-pics">
          {pics.map((p) => (
            <a key={p} href={api.attachmentUrl(project!, p)} target="_blank" rel="noreferrer">
              <img src={api.attachmentUrl(project!, p)} alt="Attached picture" loading="lazy" />
            </a>
          ))}
        </span>
      )}
      {rest && <p>{rest}</p>}
    </>
  );
}
