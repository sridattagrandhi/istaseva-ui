/**
 * De-duplicate a list of spoken languages case-insensitively and present each
 * Title-Cased. Listing metadata often carries the same language twice in
 * different casing (e.g. ["english", "English"]), which rendered as a repeated
 * list ("english, hindi, English, Hindi") on the dashboard profile.
 */
export function formatLanguageList(langs?: string[] | null): string {
  if (!langs?.length) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of langs) {
    const l = String(raw).trim();
    if (!l) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l.charAt(0).toUpperCase() + l.slice(1).toLowerCase());
  }
  return out.join(", ");
}
