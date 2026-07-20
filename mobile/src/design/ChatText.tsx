// ChatText — lightweight markdown renderer for AI chat bubbles.
//
// The assistant + onboarding agents emit a small markdown subset in their
// replies (bullet lists, **bold**, numbered steps). RN <Text> renders that
// raw ("* What it's called…"), which reads like a glitch. This handles just
// that subset — no headings, links, or nesting — keeping bubbles light:
//   - "* item" / "- item" / "• item"  → "•  item" with a hanging indent
//   - "1. item"                        → "1.  item" with a hanging indent
//   - "**bold**" inline spans          → semibold
// Everything else passes through verbatim.
import React from "react";
import { View, Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { font } from "./theme";

const BULLET_RE = /^\s*([*\-•]|\d+[.)])\s+(.*)$/;

/**
 * Voice transcripts deliver markdown lists with their newlines collapsed
 * ("overview:* **A:** …night.* **B:** …") — the line-anchored BULLET_RE
 * can't see those, so the lone asterisks rendered raw. Re-break them into
 * real bullet lines. Conservative on purpose: only a lone "*" followed by
 * whitespace and a "**bold**" span counts as a collapsed marker — never
 * arithmetic ("2 * 3") or the inside of a bold span. Mirrors the web
 * ChatMarkdown (src/components/assistant/ChatMarkdown.tsx).
 */
function restoreCollapsedBullets(text: string): string {
  return text.replace(/([^*\n])\*[ \t]+(?=\*\*)/g, "$1\n* ");
}

function InlineMd({ text, style, boldStyle }: { text: string; style?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle> }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4
          ? <Text key={i} style={[{ fontFamily: font.bodySemi }, boldStyle]}>{part.slice(2, -2)}</Text>
          : part,
      )}
    </Text>
  );
}

export function ChatText({ text, style, boldStyle }: {
  text: string;
  /** Base text style — same one the plain <Text> bubble used. */
  style?: StyleProp<TextStyle>;
  boldStyle?: StyleProp<TextStyle>;
}) {
  const lines = restoreCollapsedBullets(String(text ?? "")).split("\n");
  // Plain single-line fast path — most replies.
  if (lines.length === 1 && !BULLET_RE.test(lines[0])) {
    return <InlineMd text={lines[0]} style={style} boldStyle={boldStyle} />;
  }
  return (
    <View>
      {lines.map((line, i) => {
        if (!line.trim()) {
          // Blank separator line → small gap, not a full empty text row.
          return <View key={i} style={st.gap} />;
        }
        const m = line.match(BULLET_RE);
        if (m) {
          const marker = /\d/.test(m[1]) ? m[1] : "•";
          return (
            <View key={i} style={st.bulletRow}>
              <Text style={[style, st.bulletGlyph]}>{marker}</Text>
              <View style={{ flex: 1 }}>
                <InlineMd text={m[2]} style={style} boldStyle={boldStyle} />
              </View>
            </View>
          );
        }
        return <InlineMd key={i} text={line} style={style} boldStyle={boldStyle} />;
      })}
    </View>
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

const st = StyleSheet.create({
  gap: { height: 8 },
  bulletRow: { flexDirection: "row", gap: 7, paddingLeft: 2, marginTop: 1 },
  bulletGlyph: { minWidth: 12 },
});
