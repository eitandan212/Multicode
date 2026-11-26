// Automatic compaction: when a request is bigger than the model's context window, shrink it and
// try again instead of failing, as Claude Code compacts a conversation that has filled up.

/** Does this error mean "the request is longer than the model can read"? */
export function isContextOverflow(message: string): boolean {
  return /prompt is too long|context(_| )length|context window|maximum context|too many (input )?tokens|input is too long|exceeds? the (maximum|model'?s?) (context|token)|request_too_large|reduce the length|413\b|string too long|token limit/i.test(
    message,
  );
}

const TRIM_NOTE = "\n…(trimmed so the request fits the model's context)\n";

/** Keeps the start and the end of a long text (where instructions and the task usually are). */
function cutMiddle(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.floor(keep * 0.6);
  return `${text.slice(0, head)}${TRIM_NOTE}${text.slice(text.length - (keep - head))}`;
}

/**
 * Shrinks a request to about `target` characters. Big file contents are trimmed first (largest
 * first, keeping their beginning and end); the instructions and the task itself stay whole.
 */
export function compactPrompt(prompt: string, target: number): string {
  if (prompt.length <= target) return prompt;
  const blocks: { start: number; end: number; body: [number, number] }[] = [];
  const re = /<file path="[^"]*">\n?([\s\S]*?)\n?<\/file>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(prompt)); ) {
    const bodyStart = m.index + m[0].indexOf(m[1]!);
    blocks.push({ start: m.index, end: m.index + m[0].length, body: [bodyStart, bodyStart + m[1]!.length] });
  }
  let out = prompt;
  if (blocks.length) {
    // Trim bodies from the largest down until the whole fits (each keeps at least 400 characters).
    const bodies = blocks.map((b) => prompt.slice(b.body[0], b.body[1]));
    let excess = prompt.length - target;
    const order = bodies.map((b, i) => [b.length, i] as const).sort((a, b) => b[0] - a[0]);
    const limit = new Map<number, number>();
    for (const [len, i] of order) {
      if (excess <= 0) break;
      const keep = Math.max(400, len - excess);
      if (keep < len) {
        limit.set(i, keep);
        excess -= len - keep - TRIM_NOTE.length;
      }
    }
    let rebuilt = "";
    let last = 0;
    blocks.forEach((b, i) => {
      const keep = limit.get(i);
      rebuilt += prompt.slice(last, b.body[0]) + (keep === undefined ? bodies[i] : cutMiddle(bodies[i]!, keep));
      last = b.body[1];
    });
    out = rebuilt + prompt.slice(last);
  }
  return out.length > target ? cutMiddle(out, target) : out;
}
