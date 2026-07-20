// Mobile LanguageContext — mirrors the web app's API: { language, setLanguage, t }.
// Screens call useLanguage() to get a translation function and to switch language.
import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n, { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES, Language } from "@/i18n";

export type { Language };

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
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base) ? (base as Language) : "en";
};

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const { t, i18n: i18nInstance } = useTranslation();
  const [language, setLanguageState] = useState<Language>(() => normalize(i18nInstance.language));

  useEffect(() => {
    const onChange = (lng: string) => setLanguageState(normalize(lng));
    i18nInstance.on("languageChanged", onChange);
    return () => {
      i18nInstance.off("languageChanged", onChange);
    };
  }, [i18nInstance]);

  const setLanguage = (lang: Language) => {
    i18n.changeLanguage(lang);
    AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang).catch(() => {
      /* persistence best-effort */
    });
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t: t as LanguageContextType["t"] }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
};
