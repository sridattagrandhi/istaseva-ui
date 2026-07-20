import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Only English (the fallback) is bundled into the entry chunk. The six Indian
// locales are ~2.2 MB of raw JSON combined, so they're loaded on demand via
// loadLanguage() — each becomes its own lazy chunk. Until a locale loads,
// i18next falls back to English for any missing key.
import en from "./locales/en.json";

// Vite turns this into one dynamic-import per file (code-split, not bundled).
// English is excluded — it's statically imported above and stays in the entry.
const localeLoaders = import.meta.glob<{ default: Record<string, string> }>([
  "./locales/*.json",
  "!./locales/en.json",
]);

export const SUPPORTED_LANGUAGES = ["en", "hi", "te", "ta", "kn", "ml", "mr"] as const;
export const LANGUAGE_STORAGE_KEY = "istaSewa.language";

const baseOf = (lng: string | undefined) => (lng ?? "en").split("-")[0];
const loaded = new Set<string>(["en"]);

/** Fetch and register a locale's translations (no-op for English or an
 *  already-loaded / unknown language). Resolves once the bundle is active. */
export async function loadLanguage(lng: string): Promise<void> {
  const base = baseOf(lng);
  if (loaded.has(base)) return;
  const loader = localeLoaders[`./locales/${base}.json`];
  if (!loader) return;
  const mod = await loader();
  i18n.addResourceBundle(base, "translation", mod.default, true, true);
  loaded.add(base);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    fallbackLng: "en",
    nonExplicitSupportedLngs: true,
    ns: ["translation"],
    defaultNS: "translation",
    nsSeparator: false,
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ["localStorage"],
    },
    returnNull: false,
  });

// If the detected/stored language isn't English, pull its bundle in the
// background and refresh once it's registered.
const detected = baseOf(i18n.language);
if (detected !== "en") {
  void loadLanguage(detected).then(() => i18n.changeLanguage(detected));
}

export default i18n;
