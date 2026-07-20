import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Mail, Lock, User, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getLegalService } from "@/domains/legal/legal.service";
import { toast } from "sonner";

const Signup = () => {
  const { t } = useLanguage();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Marketing consent is OPT-IN (unchecked by default) — DPDP wants an
  // affirmative action, not a pre-ticked box.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  // Terms + Privacy acceptance is REQUIRED and recorded in the consent trail
  // (LEG-001: signup must reference a versioned policy).
  const [termsAccepted, setTermsAccepted] = useState(false);
  // 18+ attestation is REQUIRED and recorded as its own consent row (LEG-003)
  // — deliberately a separate checkbox from the Terms, so the ledger shows
  // which representation the user made. Attestation only; no date of birth.
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const { signup } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password) { toast.error(t("signup.errFields")); return; }
    if (password.length < 6) { toast.error(t("signup.errPasswordLen")); return; }
    if (!termsAccepted) {
      toast.error(t("signup.errTerms", { defaultValue: "Please accept the Terms of Service and Privacy Policy to continue." }));
      return;
    }
    if (!ageConfirmed) {
      toast.error(t("signup.errAge", { defaultValue: "IstaSeva is for adults — please confirm you are 18 or older to continue." }));
      return;
    }
    setLoading(true);
    // Role is no longer chosen at signup — every account starts as a guest and
    // can later opt into hosting, providing, or transport from their dashboard.
    const success = await signup(name, email, password, "guest");
    setLoading(false);
    if (success) {
      // signup() sets the session before returning, so the authed consent
      // write fires here and is AWAITED (LEG-001: every account needs a
      // versioned terms row). On failure a pending flag persists and the
      // write retries on the next authenticated app load — signup itself is
      // not blocked, since the acceptance already happened in the UI.
      await getLegalService().recordSignupConsents(marketingOptIn);
      toast.success(t("signup.created"));
      navigate("/verify-email");
    }
  };

  return (
    <div className="min-h-screen bg-background flex">
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-secondary via-secondary/90 to-secondary/70 text-secondary-foreground p-12 flex-col justify-between relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        <div className="relative z-10">
          <div className="flex items-center gap-2.5 mb-16">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center"><span className="font-extrabold text-sm">IS</span></div>
            <span className="font-display font-extrabold text-2xl">IstaSeva</span>
          </div>
          <h2 className="font-display text-4xl font-extrabold leading-tight mb-4">{t("signup.leftHeading")}</h2>
          <p className="text-lg opacity-80 max-w-md">{t("signup.leftSubtitle")}</p>
        </div>
        <div className="relative z-10 space-y-3 text-sm opacity-70">
          <p>{t("signup.perk1")}</p>
          <p>{t("signup.perk2")}</p>
          <p>{t("signup.perk3")}</p>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md space-y-6">
          <div>
            <h1 className="font-display text-3xl font-extrabold text-foreground">{t("signup.title")}</h1>
            <p className="text-muted-foreground mt-2">{t("signup.subtitle")}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="signup-name" className="text-sm font-medium block mb-2">{t("signup.nameLabel")}</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <input id="signup-name" type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder={t("signup.namePlaceholder")}
                  className="w-full pl-10 pr-4 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
              </div>
            </div>
            <div>
              <label htmlFor="signup-email" className="text-sm font-medium block mb-2">{t("signup.emailLabel")}</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <input id="signup-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t("signup.emailPlaceholder")}
                  className="w-full pl-10 pr-4 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
              </div>
            </div>
            <div>
              <label htmlFor="signup-password" className="text-sm font-medium block mb-2">{t("signup.passwordLabel")}</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <input id="signup-password" type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t("signup.passwordPlaceholder")}
                  className="w-full pl-10 pr-12 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? t("signup.hidePassword", { defaultValue: "Hide password" }) : t("signup.showPassword", { defaultValue: "Show password" })} aria-pressed={showPassword} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                  {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox id="terms-accept" checked={termsAccepted} onCheckedChange={(v) => setTermsAccepted(v === true)} className="mt-0.5" />
              <label htmlFor="terms-accept" className="text-sm text-muted-foreground cursor-pointer">
                {t("signup.termsLead", { defaultValue: "I agree to the" })}{" "}
                <Link to="/terms" target="_blank" className="text-primary underline">{t("signup.termsLink", { defaultValue: "Terms of Service" })}</Link>{" "}
                {t("signup.termsAnd", { defaultValue: "and" })}{" "}
                <Link to="/privacy" target="_blank" className="text-primary underline">{t("signup.privacyLink", { defaultValue: "Privacy Policy" })}</Link>
              </label>
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox id="age-confirm" checked={ageConfirmed} onCheckedChange={(v) => setAgeConfirmed(v === true)} className="mt-0.5" />
              <label htmlFor="age-confirm" className="text-sm text-muted-foreground cursor-pointer">
                {t("signup.ageAttest", { defaultValue: "I confirm that I am 18 years of age or older" })}
              </label>
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox id="marketing-opt-in" checked={marketingOptIn} onCheckedChange={(v) => setMarketingOptIn(v === true)} className="mt-0.5" />
              <label htmlFor="marketing-opt-in" className="text-sm text-muted-foreground cursor-pointer">
                {t("signup.marketingOptIn", { defaultValue: "Send me travel ideas, offers and updates. You can change this anytime in your profile." })}
              </label>
            </div>
            <Button type="submit" className="w-full h-12 rounded-xl text-base font-semibold" disabled={loading}>
              {loading ? t("signup.creating") : t("signup.createAccount")} <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {t("signup.hasAccount")} <Link to="/login" className="text-primary font-semibold hover:underline">{t("signup.login")}</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Signup;
