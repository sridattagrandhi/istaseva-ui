/**
 * ChatMarkdown — lightweight markdown renderer for assistant chat bubbles.
 *
 * The agent emits a small markdown subset in replies (bullet lists, **bold**,
 * numbered steps); plain text rendering showed the raw asterisks. This handles
 * just that subset — no headings, links, raw HTML, or nesting — as pure React
 * elements, so there's no sanitisation surface and no markdown dependency.
 * Mirrors mobile's ChatText (mobile/src/design/ChatText.tsx):
 *   - "* item" / "- item" / "• item"  → "•  item" with a hanging indent
 *   - "1. item"                        → "1.  item" with a hanging indent
 *   - "**bold**" inline spans          → semibold
 * Everything else passes through verbatim.
 */
import { Fragment } from "react";

const BULLET_RE = /^\s*([*\-•]|\d+[.)])\s+(.*)$/;

/**
 * Voice transcripts deliver markdown lists with their newlines collapsed
 * ("overview:* **A:** …night.* **B:** …") — the line-anchored BULLET_RE
 * can't see those, so the lone asterisks rendered raw. Re-break them into
 * real bullet lines. Conservative on purpose: only a lone "*" followed by
 * whitespace and a "**bold**" span counts as a collapsed marker — never
 * arithmetic ("2 * 3") or the inside of a bold span.
 */
function restoreCollapsedBullets(text: string): string {
  return text.replace(/([^*\n])\*[ \t]+(?=\*\*)/g, "$1\n* ");
}

function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = restoreCollapsedBullets(String(text ?? "")).split("\n");
  // Plain single-line fast path — most replies.
  if (lines.length === 1 && !BULLET_RE.test(lines[0])) {
    return <InlineMd text={lines[0]} />;
  }
  return (
    <div>
      {lines.map((line, i) => {
        if (!line.trim()) {
          // Blank separator line → small gap, not a full empty text row.
          return <div key={i} className="h-2" aria-hidden />;
        }
        const m = line.match(BULLET_RE);
        if (m) {
          const marker = /\d/.test(m[1]) ? m[1] : "•";
          return (
            <div key={i} className="flex gap-1.5 pl-0.5">
              <span className="min-w-[12px] shrink-0">{marker}</span>
              <span className="min-w-0 flex-1">
                <InlineMd text={m[2]} />
              </span>
            </div>
          );
        }
        return (
          <div key={i}>
            <InlineMd text={line} />
          </div>
        );
      })}
    </div>
  );
}

/** Strip the same markdown subset for TTS so the voice doesn't read
 *  "asterisk asterisk" — bullets become sentence-ish pauses. */
export function stripChatMarkdown(text: string): string {
  return restoreCollapsedBullets(String(text ?? ""))
    .split("\n")
    .map((line) => {
      const m = line.match(BULLET_RE);
      return (m ? m[2] : line).replace(/\*\*([^*]+)\*\*/g, "$1");
    })
    .filter((l) => l.trim())
    .join(". ")
    .replace(/\.\s*\./g, ".");
}
