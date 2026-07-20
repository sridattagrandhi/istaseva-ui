import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { CheckCircle2, Mail, RefreshCw, Smartphone } from "lucide-react";
import { getAuth } from "firebase/auth";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { friendlyOtpError } from "@/lib/firebase-errors";
import { toast } from "sonner";

const COUNTRY_CODES = [
  { code: "+91", flag: "🇮🇳", label: "India" },
  { code: "+1", flag: "🇺🇸", label: "US" },
];

const Verify = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const {
    isAuthenticated,
    user,
    verificationStep,
    signInWithPhone,
    verifyOtp,
    resendEmailVerification,
    refreshSession,
  } = useAuth();

  const emailVerified = !!user?.emailVerified;
  const phoneVerified = !!user?.phoneVerified;

  const [countryCode, setCountryCode] = useState("+91");
  const [localNumber, setLocalNumber] = useState(
    user?.phone ? user.phone.replace(/^\+\d+/, "") : "",
  );
  const [verificationId, setVerificationId] = useState("");
  const [otp, setOtp] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Two independent timers — keeping them separate fixes the prior bug where
  // a user who waited the full SMS window saw "Code valid for 0s" but the
  // resend button claimed "Resend in 0s" because both shared one countdown.
  //
  //   • OTP_VALIDITY_SECONDS — how long the SMS code stays valid (5 min).
  //     This is the visible "Code expires in M:SS" timer the user trusts.
  //   • RESEND_COOLDOWN_SECONDS — how long until the Resend button unlocks
  //     (1 min). Aligns with Firebase's per-number throttle so smashing
  //     Resend doesn't trip `auth/too-many-requests`.
  const OTP_VALIDITY_SECONDS = 5 * 60;
  const RESEND_COOLDOWN_SECONDS = 60;
  const [otpExpiresIn, setOtpExpiresIn] = useState(0);
  const [resendCooldown, setResendCooldown] = useState(0);
  useEffect(() => {
    if (otpExpiresIn <= 0 && resendCooldown <= 0) return;
    const id = window.setInterval(() => {
      setOtpExpiresIn((s) => (s <= 1 ? 0 : s - 1));
      setResendCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [otpExpiresIn, resendCooldown]);

  // Mirror countdown for the email verification link. Firebase's email
  // verification links expire one hour after issuance — surface that as
  // a live countdown so the user knows whether the link in their inbox
  // is still valid, and so they can intentionally resend before clicking
  // a stale one. The timer starts the first time the page loads (we
  // assume the signup flow issued an email moments earlier) and resets
  // whenever the user taps "Resend email".
  const EMAIL_LINK_TTL_SECONDS = 60 * 60;
  const EMAIL_RESEND_COOLDOWN_SECONDS = 60;
  const [emailExpiresIn, setEmailExpiresIn] = useState(EMAIL_LINK_TTL_SECONDS);
  const [emailResendCooldown, setEmailResendCooldown] = useState(0);
  useEffect(() => {
    if (emailVerified) return;
    const id = window.setInterval(() => {
      setEmailExpiresIn((s) => (s <= 1 ? 0 : s - 1));
      setEmailResendCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [emailVerified]);
  const formatMMSS = (totalSeconds: number) => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Poll Firebase for email verification while the email step is pending.
  useEffect(() => {
    if (emailVerified) return;
    const interval = window.setInterval(async () => {
      const refreshed = await refreshSession();
      if (refreshed && getAuth().currentUser?.emailVerified) {
        // refreshSession updates context, no manual nav needed — guard below
        // will redirect once both email + phone are verified.
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [emailVerified, refreshSession]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (verificationStep === "complete")
    return <Navigate to={`/dashboard/${user?.role || "guest"}`} replace />;

  const fullPhone = `${countryCode}${localNumber.replace(/\D/g, "")}`;
  const placeholder =
    countryCode === "+91"
      ? t("login.phonePlaceholderIN")
      : t("login.phonePlaceholderUS");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="font-display text-3xl font-bold">{t("verify.title")}</h1>
          <p className="text-muted-foreground">{t("verify.subtitle")}</p>
        </div>

        {/* Email card */}
        <div className="bg-card border border-border rounded-3xl p-6 space-y-4">
          <div className="flex items-start gap-4">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                emailVerified
                  ? "bg-success/10 text-success"
                  : "bg-primary/10 text-primary"
              }`}
            >
              {emailVerified ? (
                <CheckCircle2 className="w-6 h-6" />
              ) : (
                <Mail className="w-6 h-6" />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold text-lg">
                  {t("verify.email.heading")}
                </h2>
                {emailVerified && (
                  <span className="text-xs font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">
                    {t("verify.email.verified")}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {emailVerified
                  ? t("verify.email.verifiedBody", {
                      email: user?.email || "",
                    })
                  : t("verify.email.body", {
                      email: user?.email || t("verify.email.yourInbox"),
                    })}
              </p>
              {/* Email link expiry countdown. The Firebase template's link
                  is valid for ~1 hour; we mirror that window here so the
                  user can tell at a glance whether their inbox link is
                  still good. When it lapses we prompt them to resend. */}
              {!emailVerified && (
                <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
                  {emailExpiresIn > 0
                    ? `Link expires in ${formatMMSS(emailExpiresIn)} — also check your spam folder.`
                    : "That link has expired. Tap Resend to get a fresh one."}
                </p>
              )}
            </div>
          </div>
          {!emailVerified && (
            <Button
              variant="outline"
              className="w-full rounded-xl"
              disabled={emailResendCooldown > 0}
              onClick={async () => {
                const success = await resendEmailVerification();
                if (success) {
                  toast.success(t("verify.email.resent"));
                  setEmailExpiresIn(EMAIL_LINK_TTL_SECONDS);
                  setEmailResendCooldown(EMAIL_RESEND_COOLDOWN_SECONDS);
                } else {
                  toast.error(t("verify.email.resendFail"));
                }
              }}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              {emailResendCooldown > 0
                ? `Resend in ${emailResendCooldown}s`
                : t("verify.email.resend")}
            </Button>
          )}
        </div>

        {/* Phone card */}
        <div className="bg-card border border-border rounded-3xl p-6 space-y-4">
          <div className="flex items-start gap-4">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                phoneVerified
                  ? "bg-success/10 text-success"
                  : "bg-primary/10 text-primary"
              }`}
            >
              {phoneVerified ? (
                <CheckCircle2 className="w-6 h-6" />
              ) : (
                <Smartphone className="w-6 h-6" />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold text-lg">
                  {t("verify.phone.heading")}
                </h2>
                {phoneVerified && (
                  <span className="text-xs font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full">
                    {t("verify.phone.verified")}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {phoneVerified
                  ? t("verify.phone.verifiedBody")
                  : t("verify.phone.body")}
              </p>
            </div>
          </div>

          {!phoneVerified && (
            <>
              <div>
                <label className="text-sm font-medium block mb-2">
                  {t("verify.phone.numberLabel")}
                </label>
                <div className="flex items-stretch border border-border rounded-xl bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/20">
                  <Select value={countryCode} onValueChange={setCountryCode}>
                    <SelectTrigger
                      aria-label={t("login.countryLabel")}
                      className="h-auto w-auto shrink-0 gap-1.5 rounded-none border-0 border-r border-border bg-muted px-3 py-3 text-sm focus:ring-0 focus:ring-offset-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNTRY_CODES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.flag} {c.code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <input
                    type="tel"
                    value={localNumber}
                    onChange={(e) =>
                      setLocalNumber(e.target.value.replace(/[^\d\s\-()]/g, ""))
                    }
                    className="flex-1 px-4 py-3 bg-background text-sm focus:outline-none"
                    placeholder={placeholder}
                  />
                </div>
              </div>

              {!verificationId ? (
                <Button
                  className="w-full rounded-xl"
                  disabled={
                    sending
                    || resendCooldown > 0
                    || localNumber.replace(/\D/g, "").length < 7
                  }
                  onClick={async () => {
                    setSending(true);
                    const result = await signInWithPhone(
                      fullPhone,
                      "verify-phone-recaptcha",
                    );
                    setSending(false);
                    if (!result.success || !result.verificationId) {
                      toast.error(friendlyOtpError(result.error) || result.error || t("verify.phone.sendFail"));
                      // Mirror the rate-limit window client-side so the next
                      // press doesn't immediately retrigger the upstream
                      // limit. Don't start the validity timer — no code was
                      // issued.
                      setResendCooldown(RESEND_COOLDOWN_SECONDS);
                      return;
                    }
                    setVerificationId(result.verificationId);
                    setOtpExpiresIn(OTP_VALIDITY_SECONDS);
                    setResendCooldown(RESEND_COOLDOWN_SECONDS);
                    toast.success(
                      t("verify.phone.sent", { phone: fullPhone }),
                    );
                  }}
                >
                  {sending
                    ? t("verify.phone.sending")
                    : resendCooldown > 0
                      ? `Resend in ${resendCooldown}s`
                      : t("verify.phone.send")}
                </Button>
              ) : (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium">
                        {t("verify.phone.codeLabel")}
                      </label>
                      {/* Live OTP-validity countdown — 5 min window from the
                          moment the SMS was issued. Independent of the
                          resend cooldown (1 min) so a user who waits past
                          the resend window can see exactly how much time
                          remains to enter the code. Hidden once expired. */}
                      {otpExpiresIn > 0 && (
                        <span className="text-[11px] font-semibold text-muted-foreground">
                          Code expires in {formatMMSS(otpExpiresIn)}
                        </span>
                      )}
                      {otpExpiresIn === 0 && (
                        <span className="text-[11px] font-semibold text-destructive">
                          Code expired — tap Resend
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm tracking-[0.3em] focus:ring-2 focus:ring-primary/20 outline-none"
                      placeholder={t("verify.phone.codePlaceholder")}
                    />
                  </div>
                  <Button
                    className="w-full rounded-xl"
                    disabled={verifying || otp.length !== 6 || otpExpiresIn === 0}
                    onClick={async () => {
                      setVerifying(true);
                      const result = await verifyOtp(verificationId, otp);
                      setVerifying(false);
                      if (!result.success) {
                        // Surface the real Firebase code via the shared
                        // mapper. This is what surfaced the "phone already
                        // linked to another account" failure mode from the
                        // signup-time OTP path; the previous generic toast
                        // hid it as a generic "verify failed".
                        toast.error(
                          friendlyOtpError(result.error)
                          || result.error
                          || t("verify.phone.verifyFail"),
                        );
                        return;
                      }
                      toast.success(t("verify.phone.success"));
                      // refreshSession is invoked inside verifyOtp; if email is
                      // already verified, the redirect at the top of this
                      // component will fire on the next render.
                      if (emailVerified) {
                        navigate(`/dashboard/${user?.role || "guest"}`, {
                          replace: true,
                        });
                      }
                    }}
                  >
                    {verifying
                      ? t("verify.phone.verifying")
                      : t("verify.phone.verify")}
                  </Button>
                  <button
                    type="button"
                    className="w-full text-sm text-muted-foreground hover:text-foreground text-center"
                    onClick={() => {
                      setVerificationId("");
                      setOtp("");
                    }}
                  >
                    {t("verify.phone.changeNumber")}
                  </button>
                </>
              )}
            </>
          )}

          <div id="verify-phone-recaptcha" />
        </div>
      </div>
    </div>
  );
};

export default Verify;
