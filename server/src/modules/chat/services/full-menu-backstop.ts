// ── Full-menu enumeration backstop ────────────────────────────────────────
// The assistant is told (in the prompt) to enumerate EVERY priced option when
// the user asks for the full menu, but it intermittently truncates the list —
// e.g. listing Men's + Kid's haircut but silently dropping Women's. These are
// the deterministic safety nets: detect a full-menu request and append any
// option the model's reply left out. Mirrors the open_listing "promote the
// tool result regardless of what the model emitted" pattern. Type-agnostic —
// works for stay rooms, service variants, and transport modes via the
// normalized `priceableOptions` returned by get_listing_details.

export type PriceableOptionLite = {
  group?: string;
  name: string;
  price: number;
  unit?: string;
  maxGuests?: number;
  addOns?: Array<{ name: string; price: number }>;
};

// Native-script "show me the whole menu" signals for the app's seven locales
// (en handled by the English regex above; hi + mr share Devanagari). Curated to
// mirror the English regex's CONSERVATISM — only phrasings that mean the FULL
// list ("tell me more", "everything", "all", "full/complete", "what all"). We
// deliberately exclude bare "how much" / "price" equivalents, which also appear
// in single-variant questions ("how much is the women's haircut?") and would
// over-trigger the append. Each alternative is commented with its language.
const NATIVE_FULL_MENU = new RegExp([
  // ── Devanagari (Hindi + Marathi) ──
  'और\\s*बता',          // "tell me more" (hi)
  'अजून\\s*सांग',        // "tell me more" (mr)
  'पूरी\\s*(जानकारी|सूची|लिस्ट|डिटेल)', // "full info/list/details" (hi)
  'सार[ेीा]',            // "all / entire" (hi)
  'सगळ[ंेा]',           // "all / everything" (mr)
  'सब\\s*कुछ',          // "everything" (hi)
  'और\\s*क्या',          // "what else" (hi)
  'अजून\\s*काय',         // "what else" (mr)
  'क्या\\s*क्या',         // "what all" (hi)
  'कौन\\s*कौन',          // "which all" (hi)
  // ── Telugu ──
  'ఇంకా\\s*చెప్ప',       // "tell me more"
  'ఇంకా\\s*ఏమ',         // "what else"
  'అన్న[ిీ]',            // "all"
  'పూర్తి',              // "full / complete"
  'ఏమ[ేి]మ[ిీ]',         // "what all"
  // ── Tamil ──
  'மேலும்',             // "more / furthermore"
  'இன்னும்\\s*சொல்',     // "tell me more"
  'எல்லாம்',            // "everything / all"
  'முழு',               // "full / whole"
  'என்ன\\s*என்ன',       // "what all"
  // ── Kannada ──
  'ಇನ್ನೂ\\s*ಹೇಳ',       // "tell me more"
  'ಎಲ್ಲಾ',              // "all / everything"
  'ಪೂರ್ತಿ',             // "full / complete"
  'ಏನೇನು',              // "what all"
  // ── Malayalam ──
  'കൂടുതൽ',             // "more"
  'എല്ലാം',             // "everything / all"
  'മുഴുവൻ',             // "full / whole"
  'എന്തെല്ലാം',          // "what all"
].join('|'));

/** Did the user ask to see the whole menu / full price list? Curated phrasings
 *  in English + transliterated Hindi/Hinglish + native script for all seven
 *  supported locales. Deterministic backstop — keep it conservative so it fires
 *  on "show me everything", not on a single-variant price question. */
export function isFullMenuIntent(text: string): boolean {
  const t = (text || '').toLowerCase();
  return /(tell me (more|about)|more (about|details)|(more|further) details|what('?s| is) it like|describe (it|this|that|the (place|salon|listing|spot))|what all|what else|everything|full (menu|list|price)|price list|all (the )?(prices|options|services|variants)|what (do|does) (they|it) (offer|have|do)|what services|other (options|services)|complete (list|menu)|show me (all|everything|the (menu|options))|list (all|everything)|the menu|how much for (everything|all)|give me (the|all) (details|options))/.test(t)
    || /(saare|sare|poora|pura|kya kya|aur kya|sab kuch|inka rate|kitne ka|sab options|aur batao|details do)/.test(t)
    || NATIVE_FULL_MENU.test(text || '');
}

const UNIT_SUFFIX: Record<string, string> = {
  per_visit: '/visit', per_hour: '/hr', per_night: '/night', per_day: '/day', package: '',
};

export function formatPriceableLine(o: PriceableOptionLite): string {
  const suffix = o.unit ? (UNIT_SUFFIX[o.unit] ?? '') : '';
  const pkg = o.unit === 'package' ? ' (package)' : '';
  const guests = o.maxGuests ? ` (sleeps ${o.maxGuests})` : '';
  let line = `• ${o.name} — ₹${o.price.toLocaleString('en-IN')}${suffix}${pkg}${guests}`;
  if (o.addOns && o.addOns.length > 0) {
    for (const a of o.addOns) {
      line += `\n    – add-on: ${a.name} +₹${a.price.toLocaleString('en-IN')}`;
    }
  }
  return line;
}

/** Append any priced option the model's reply omitted. Returns the message
 *  unchanged unless (a) ≥2 options exist and (b) at least one option's price
 *  is absent from the reply. We append ONLY the missing options (not the whole
 *  list) to avoid duplicating what the model already wrote — and we add no
 *  English lead-in, so the completion stays language-neutral in non-English
 *  conversations. */
export function appendMissingMenuOptions(message: string, options: PriceableOptionLite[]): string {
  if (!Array.isArray(options) || options.length < 2) return message;
  // Strip ₹, commas, whitespace so "₹1,200" / "1200" / "₹1200" all match.
  const normMsg = message.replace(/[,₹\s]/g, '');
  const missing = options.filter((o) => !normMsg.includes(String(o.price)));
  if (missing.length === 0) return message;
  return `${message.trimEnd()}\n${missing.map(formatPriceableLine).join('\n')}`;
}
