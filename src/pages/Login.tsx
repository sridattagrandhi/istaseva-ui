import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Mail, Lock, ArrowRight, Shield, Star, Users, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { friendlyLoginError, friendlyOtpError } from "@/lib/firebase-errors";
import { getListingService } from "@/domains";
import { LAST_DASHBOARD_KEY } from "@/lib/last-dashboard";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

// Mirrors the section split in MyListings: stays → Host dashboard,
// driver-* → Transport dashboard, everything else → Provider dashboard.
const STAY_CATEGORIES = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]);
const PROVIDER_DASHBOARDS = new Set(["/dashboard/provider", "/dashboard/host", "/dashboard/transport"]);

/**
 * Post-login landing: providers (anyone who owns a listing) go straight to
 * their dashboard — the last-visited provider dashboard when we remember
 * one, else the dashboard matching their first listing's type. Everyone
 * else lands on the discovery marketplace. The navbar's role-switch pill is
 * the way back and forth. Fails open to discovery on a fetch error.
 */
async function resolvePostLoginDestination(): Promise<string> {
  try {
    const result = await getListingService().getByUserId("me");
    const listings = result.success ? result.data ?? [] : [];
    if (listings.length === 0) return "/";
    const last = localStorage.getItem(LAST_DASHBOARD_KEY);
    if (last && PROVIDER_DASHBOARDS.has(last)) return last;
    const cat = String(listings[0]?.category || "");
    if (STAY_CATEGORIES.has(cat)) return "/dashboard/host";
    if (cat.startsWith("driver-")) return "/dashboard/transport";
    return "/dashboard/provider";
  } catch {
    return "/";
  }
}

const Login = () => {
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [localPhone, setLocalPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [verificationId, setVerificationId] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const { login, signInWithPhone, verifyOtp } = useAuth();
  const navigate = useNavigate();

  // Throttle OTP sends + email login attempts client-side. Backend enforces
  // its own limit; this is a UX guard so users can't spam the button.
  const RL_KEY = "isaSeva:authRateLimit";
  const readRl = (): { otpSends: number[]; otpByPhone: Record<string, number>; loginAttempts: number[] } => {
    try { return JSON.parse(sessionStorage.getItem(RL_KEY) || "") || { otpSends: [], otpByPhone: {}, loginAttempts: [] }; }
    catch { return { otpSends: [], otpByPhone: {}, loginAttempts: [] }; }
  };
  const writeRl = (v: ReturnType<typeof readRl>) => sessionStorage.setItem(RL_KEY, JSON.stringify(v));
  const checkOtpRateLimit = (phone: string): { ok: boolean; reason?: string; retryIn?: number } => {
    const now = Date.now();
    const rl = readRl();
    rl.otpSends = rl.otpSends.filter(t => now - t < 10 * 60_000);
    const lastForPhone = rl.otpByPhone[phone] || 0;
    if (now - lastForPhone < 30_000) return { ok: false, reason: "cooldown", retryIn: Math.ceil((30_000 - (now - lastForPhone)) / 1000) };
    if (rl.otpSends.length >= 5) return { ok: false, reason: "max", retryIn: Math.ceil((10 * 60_000 - (now - rl.otpSends[0])) / 1000) };
    return { ok: true };
  };
  const recordOtpSend = (phone: string) => {
    const now = Date.now();
    const rl = readRl();
    rl.otpSends.push(now);
    rl.otpByPhone[phone] = now;
    writeRl(rl);
  };
  const checkLoginRateLimit = (): { ok: boolean; retryIn?: number } => {
    const now = Date.now();
    const rl = readRl();
    rl.loginAttempts = rl.loginAttempts.filter(t => now - t < 60_000);
    if (rl.loginAttempts.length >= 5) return { ok: false, retryIn: Math.ceil((60_000 - (now - rl.loginAttempts[0])) / 1000) };
    return { ok: true };
  };
  const recordLoginAttempt = () => {
    const rl = readRl();
    rl.loginAttempts.push(Date.now());
    writeRl(rl);
  };

  // Tick down the visible cooldown counter so users see when they can retry.
  useEffect(() => {
    if (otpCooldown <= 0) return;
    const id = window.setInterval(() => setOtpCooldown(s => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [otpCooldown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast.error(t("login.errEmail")); return; }
    const limit = checkLoginRateLimit();
    if (!limit.ok) { toast.error(`Too many login attempts. Try again in ${limit.retryIn}s.`); return; }
    recordLoginAttempt();
    setLoading(true);
    const { user: loggedIn, error } = await login(email, password);
    setLoading(false);
    if (loggedIn) {
      toast.success(t("login.welcomeBack"));
      // Honour an explicit ?redirect=, send admins to their portal, then
      // split by side: listing owners → their provider dashboard, everyone
      // else → the discovery marketplace.
      const explicit = searchParams.get("redirect");
      if (explicit) navigate(explicit);
      else if (loggedIn.role === "admin") navigate("/admin");
      else navigate(await resolvePostLoginDestination());
    } else {
      toast.error(friendlyLoginError(error) || t("login.errSignInFail"));
    }
  };

  const handleSendOtp = async () => {
    const digits = localPhone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      toast.error(t("login.errPhoneInvalid"));
      return;
    }
    if (!/^\+\d{1,3}$/.test(countryCode)) {
      toast.error(t("login.errPhoneInvalid"));
      return;
    }

    const fullPhone = `${countryCode}${digits}`;
    const limit = checkOtpRateLimit(fullPhone);
    if (!limit.ok) {
      if (limit.reason === "cooldown") {
        toast.error(`Please wait ${limit.retryIn}s before requesting another OTP.`);
        setOtpCooldown(limit.retryIn || 0);
      } else {
        toast.error(`Too many OTP requests. Try again in ${Math.ceil((limit.retryIn || 0) / 60)} min.`);
      }
      return;
    }

    setSendingOtp(true);
    const result = await signInWithPhone(fullPhone, "login-phone-recaptcha");
    setSendingOtp(false);

    if (!result.success || !result.verificationId) {
      toast.error(result.error || t("login.errOtpSendFail"));
      return;
    }

    recordOtpSend(fullPhone);
    setOtpCooldown(30);
    setVerificationId(result.verificationId);
    toast.success(t("login.otpSent"));
  };

  const handleVerifyOtp = async () => {
    if (!verificationId || !/^\d{6}$/.test(otp)) {
      toast.error(t("login.errOtpInvalid"));
      return;
    }

    setVerifyingOtp(true);
    const result = await verifyOtp(verificationId, otp);
    setVerifyingOtp(false);

    if (result.success) {
      toast.success(t("login.phoneVerified"));
      // Same landing logic as the email path: explicit ?redirect= wins,
      // else provider-vs-user split via resolvePostLoginDestination.
      const explicit = searchParams.get("redirect");
      navigate(explicit || await resolvePostLoginDestination());
    } else {
      toast.error(friendlyOtpError(result.error) || t("login.errOtpVerifyFail"));
    }
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Left decorative panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary via-primary/90 to-primary/70 text-primary-foreground p-12 flex-col justify-between relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-secondary/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/3 w-64 h-64 bg-accent/10 rounded-full blur-3xl" />
        <div className="relative z-10">
          <Link to="/" className="flex items-center gap-2.5 mb-16">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center"><span className="font-extrabold text-sm">IS</span></div>
            <span className="font-display font-extrabold text-2xl">IstaSeva</span>
          </Link>
          <h2 className="font-display text-4xl font-extrabold leading-tight mb-4">{t("login.leftHeading")}</h2>
          <p className="text-lg opacity-80 max-w-md">{t("login.leftSubtitle")}</p>
        </div>
        <div className="relative z-10 space-y-4">
          <div className="flex items-center gap-3 bg-white/10 rounded-xl p-4 backdrop-blur-sm">
            <Shield className="w-8 h-8 opacity-80" />
            <div>
              <p className="font-semibold text-sm">{t("login.trust1Title")}</p>
              <p className="text-xs opacity-70">{t("login.trust1Desc")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 bg-white/10 rounded-xl p-4 backdrop-blur-sm">
            <Star className="w-8 h-8 opacity-80" />
            <div>
              <p className="font-semibold text-sm">{t("login.trust2Title")}</p>
              <p className="text-xs opacity-70">{t("login.trust2Desc")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 bg-white/10 rounded-xl p-4 backdrop-blur-sm">
            <Users className="w-8 h-8 opacity-80" />
            <div>
              <p className="font-semibold text-sm">{t("login.trust3Title")}</p>
              <p className="text-xs opacity-70">{t("login.trust3Desc")}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md space-y-8">
          <div className="lg:hidden flex items-center gap-2.5 mb-4">
            <Link to="/" className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center">
                <span className="text-primary-foreground font-extrabold text-sm">IS</span>
              </div>
              <span className="font-display font-extrabold text-xl text-foreground">Ista<span className="text-primary">Seva</span></span>
            </Link>
          </div>
          <div>
            <h1 className="font-display text-3xl font-extrabold text-foreground">{t("login.title")}</h1>
            <p className="text-muted-foreground mt-2">{t("login.subtitle")}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-email" className="text-sm font-medium text-foreground block mb-2">{t("login.emailLabel")}</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <input id="login-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t("login.emailPlaceholder")}
                  className="w-full pl-10 pr-4 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
              </div>
            </div>
            <div>
              <label htmlFor="login-password" className="text-sm font-medium text-foreground block mb-2">{t("login.passwordLabel")}</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <input id="login-password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t("login.passwordPlaceholder")}
                  className="w-full pl-10 pr-12 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? t("login.hidePassword", { defaultValue: "Hide password" }) : t("login.showPassword", { defaultValue: "Show password" })} aria-pressed={showPassword} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                  {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
              <div className="mt-2 text-right">
                <Link to="/forgot-password" className="text-sm text-primary hover:underline">{t("login.forgotPassword")}</Link>
              </div>
            </div>
            <Button type="submit" className="w-full h-12 rounded-xl text-base font-semibold" disabled={loading}>
              {loading ? t("login.signingIn") : t("login.signIn")} {!loading && <ArrowRight className="w-4 h-4 ml-1" />}
            </Button>
          </form>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
            <div>
              <h2 className="font-semibold text-foreground">{t("login.otpTitle")}</h2>
              <p className="text-sm text-muted-foreground mt-1">{t("login.otpSubtitle")}</p>
            </div>
            <div>
              <label htmlFor="login-phone" className="text-sm font-medium text-foreground block mb-2">{t("login.phoneLabel")}</label>
              <div className="flex items-stretch border border-border rounded-xl bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary transition-all">
                <Select value={countryCode} onValueChange={setCountryCode}>
                  <SelectTrigger
                    aria-label={t("login.countryLabel")}
                    className="h-auto w-auto shrink-0 gap-1.5 rounded-none border-0 border-r border-border bg-muted px-3 py-3 text-sm focus:ring-0 focus:ring-offset-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="+91">🇮🇳 +91</SelectItem>
                    <SelectItem value="+1">🇺🇸 +1</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative flex-1">
                  <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                  <input
                    id="login-phone"
                    type="tel"
                    value={localPhone}
                    onChange={(e) => {
                      const cleaned = e.target.value.replace(/[^\d\s\-()]/g, "");
                      // Cap at 20 raw chars so the digit count stays within E.164 (max 15)
                      // even with formatting characters.
                      setLocalPhone(cleaned.slice(0, 20));
                    }}
                    inputMode="tel"
                    autoComplete="tel-national"
                    maxLength={20}
                    placeholder={countryCode === "+91" ? t("login.phonePlaceholderIN") : t("login.phonePlaceholderUS")}
                    className="w-full pl-10 pr-4 py-3 bg-background text-sm focus:outline-none"
                  />
                </div>
              </div>
            </div>
            {!verificationId ? (
              <Button type="button" variant="outline" className="w-full rounded-xl" disabled={sendingOtp || otpCooldown > 0} onClick={handleSendOtp}>
                {sendingOtp ? t("login.sendingOtp") : otpCooldown > 0 ? `Resend in ${otpCooldown}s` : t("login.sendOtp")}
              </Button>
            ) : (
              <>
                <div>
                  <label htmlFor="login-otp" className="text-sm font-medium text-foreground block mb-2">{t("login.enterOtp")}</label>
                  <input
                    id="login-otp"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                    placeholder={t("login.otpPlaceholder")}
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm tracking-[0.3em] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                  />
                </div>
                <Button type="button" className="w-full rounded-xl" disabled={verifyingOtp} onClick={handleVerifyOtp}>
                  {verifyingOtp ? t("login.verifying") : t("login.verifyOtp")}
                </Button>
              </>
            )}
            <div id="login-phone-recaptcha" />
          </div>

          <p className="text-center text-sm text-muted-foreground">
            {t("login.noAccount")} <Link to="/signup" className="text-primary font-semibold hover:underline">{t("login.signUp")}</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
