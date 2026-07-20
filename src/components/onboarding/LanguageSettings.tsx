import { Globe } from "lucide-react";
import { languages, Language, useLanguage } from "@/contexts/LanguageContext";

interface LanguageSettingsProps {
  displayLang: Language;
  spokenInputLang: Language;
  onDisplayLangChange: (lang: Language) => void;
  onSpokenInputLangChange: (lang: Language) => void;
  onClose: () => void;
}

const LanguageSettings = ({
  displayLang,
  spokenInputLang,
  onDisplayLangChange,
  onSpokenInputLangChange,
  onClose,
}: LanguageSettingsProps) => {
  const { t } = useLanguage();
  return (
    <div className="absolute inset-0 z-40 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="max-w-sm w-full bg-card border border-border rounded-2xl p-5 shadow-lg">
        <div className="flex items-center gap-2 mb-5">
          <Globe className="w-5 h-5 text-primary" />
          <h3 className="font-display font-bold text-foreground">{t("onboarding.langSettingsTitle", { defaultValue: "Language Settings" })}</h3>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.displayLanguage", { defaultValue: "Display Language" })}</p>
            <p className="text-[10px] text-muted-foreground mb-2">{t("onboarding.displayLanguageHint", { defaultValue: "Text and UI will appear in this language" })}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {languages.map(l => (
                <button
                  key={l.code}
                  onClick={() => onDisplayLangChange(l.code)}
                  className={`px-3 py-2 text-xs font-medium rounded-xl border transition-all ${
                    displayLang === l.code
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground hover:border-primary/50"
                  }`}
                >
                  {l.nativeName}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.voiceInputLanguage", { defaultValue: "Voice Input Language" })}</p>
            <p className="text-[10px] text-muted-foreground mb-2">{t("onboarding.voiceInputLanguageHint", { defaultValue: "Speak in this language — can differ from display" })}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {languages.map(l => (
                <button
                  key={l.code}
                  onClick={() => onSpokenInputLangChange(l.code)}
                  className={`px-3 py-2 text-xs font-medium rounded-xl border transition-all ${
                    spokenInputLang === l.code
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border bg-card text-foreground hover:border-accent/50"
                  }`}
                >
                  {l.nativeName}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full mt-5 py-2.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors"
        >
          {t("onboarding.done", { defaultValue: "Done" })}
        </button>
      </div>
    </div>
  );
};

export default LanguageSettings;
