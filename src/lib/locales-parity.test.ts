import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Locale-file drift guard. All 7 web locales and all 7 mobile locales must
 * carry IDENTICAL key sets — a key added to one file but not the others
 * silently falls back to the t() defaultValue (English) for the missing
 * languages, which is exactly how the signup terms-consent block shipped
 * untranslated. process.cwd() is correct here (web-side test, root suite).
 */
const LANGS = ["en", "hi", "kn", "ml", "mr", "ta", "te"] as const;

const keysOf = (relPath: string): Set<string> =>
  new Set(Object.keys(JSON.parse(readFileSync(resolve(process.cwd(), relPath), "utf8"))));

const diff = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((k) => !b.has(k)).slice(0, 10);

describe("locale key-set parity", () => {
  it("all 7 web locales have identical key sets", () => {
    const base = keysOf("src/locales/en.json");
    for (const lang of LANGS) {
      const other = keysOf(`src/locales/${lang}.json`);
      expect.soft(diff(base, other), `keys in en but missing from ${lang}`).toEqual([]);
      expect.soft(diff(other, base), `keys in ${lang} but missing from en`).toEqual([]);
    }
  });

  it("all 7 mobile locales have identical key sets", () => {
    const base = keysOf("mobile/src/i18n/locales/en.json");
    for (const lang of LANGS) {
      const other = keysOf(`mobile/src/i18n/locales/${lang}.json`);
      expect.soft(diff(base, other), `keys in en but missing from ${lang}`).toEqual([]);
      expect.soft(diff(other, base), `keys in ${lang} but missing from en`).toEqual([]);
    }
  });
});
