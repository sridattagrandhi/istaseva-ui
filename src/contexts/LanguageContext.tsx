import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18n, { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES, loadLanguage } from "@/i18n";

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

interface LanguageOption {
  code: Language;
  name: string;
  nativeName: string;
}

export const languages: LanguageOption[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்" },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ" },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം" },
  { code: "mr", name: "Marathi", nativeName: "मराठी" },
];

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const normalize = (lng: string | undefined): Language => {
  const base = (lng ?? "en").split("-")[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as Language)
    : "en";
};

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const { t, i18n: i18nInstance } = useTranslation();
  const [language, setLanguageState] = useState<Language>(() => normalize(i18nInstance.language));

  useEffect(() => {
    // Keep the document's <html lang> in sync with the active language so
    // screen readers pronounce correctly, SEO reads the right locale, and the
    // browser's "translate this page" prompt behaves. Without this the app
    // switches all copy but leaves lang="en" permanently. (PUX-003)
    const applyDocumentLang = (lng: string) => {
      if (typeof document !== "undefined") {
        document.documentElement.lang = normalize(lng);
      }
    };
    const onChange = (lng: string) => {
      setLanguageState(normalize(lng));
      applyDocumentLang(lng);
    };
    applyDocumentLang(i18nInstance.language);
    i18nInstance.on("languageChanged", onChange);
    return () => {
      i18nInstance.off("languageChanged", onChange);
    };
  }, [i18nInstance]);

  const setLanguage = (lang: Language) => {
    // Load the locale's (lazy) chunk first, then switch so the UI doesn't flash
    // English keys. English is already bundled, so it switches instantly.
    void loadLanguage(lang).then(() => {
      i18n.changeLanguage(lang);
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
      } catch {
        // localStorage may be unavailable (private mode, SSR) — detection handles fallback
      }
    });
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
};
