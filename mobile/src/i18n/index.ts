// Mobile i18n — mirrors the web app's react-i18next setup (flat dotted keys,
// nsSeparator off). Language is persisted in AsyncStorage and restored on boot.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";

import en from "./locales/en.json";
import hi from "./locales/hi.json";
import te from "./locales/te.json";
import ta from "./locales/ta.json";
import kn from "./locales/kn.json";
import ml from "./locales/ml.json";
import mr from "./locales/mr.json";

export const SUPPORTED_LANGUAGES = ["en", "hi", "te", "ta", "kn", "ml", "mr"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const LANGUAGE_STORAGE_KEY = "istaSewa.language";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hi: { translation: hi },
    te: { translation: te },
    ta: { translation: ta },
    kn: { translation: kn },
    ml: { translation: ml },
    mr: { translation: mr },
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  nonExplicitSupportedLngs: true,
  ns: ["translation"],
  defaultNS: "translation",
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  compatibilityJSON: "v3",
});

// Restore the saved language asynchronously after init.
AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
  .then((saved) => {
    if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved) && saved !== i18n.language) {
      i18n.changeLanguage(saved);
    }
  })
  .catch(() => {
    /* AsyncStorage unavailable — stay on default */
  });

export default i18n;
