// design/screens/OnboardingScreen.tsx — dark auth flow ported from onboarding.jsx.
// splash → language → login / signup / forgot → phone OTP → email verify → onDone (reset to Tabs).
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Modal } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../Icon";
import { LogoMark } from "../LogoMark";
import { font, noOutline } from "../theme";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage, languages } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";
import { setConsent } from "../api/consents";
import { fetchMyListings } from "../api/dash";
import type { RootParamList } from "../Navigator";

type TFn = (key: string, options?: Record<string, unknown>) => string;

function authError(e: unknown, t: TFn): string {
  const err = e as { code?: string; message?: string } | null | undefined;
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return t("m.onboarding.errIncorrect", { defaultValue: "Email or password is incorrect." });
  if (code.includes("email-already-in-use")) return t("m.onboarding.errEmailInUse", { defaultValue: "That email already has an account. Try logging in." });
  if (code.includes("invalid-email")) return t("m.onboarding.errInvalidEmail", { defaultValue: "Please enter a valid email address." });
  if (code.includes("weak-password")) return t("m.onboarding.errWeakPassword", { defaultValue: "Password should be at least 6 characters." });
  // Phone / OTP errors.
  if (code.includes("invalid-verification-code")) return t("m.onboarding.errOtpInvalid", { defaultValue: "That code is incorrect. Please re-enter it." });
  if (code.includes("code-expired") || code.includes("missing-verification-id") || code.includes("session-expired")) return t("m.onboarding.errOtpExpired", { defaultValue: "That code expired — tap Resend for a new one." });
  if (code.includes("credential-already-in-use") || code.includes("account-exists-with-different-credential") || code.includes("phone-number-already-exists")) return t("m.onboarding.errPhoneInUse", { defaultValue: "That phone number is already linked to another account." });
  if (code.includes("invalid-phone-number")) return t("m.onboarding.errPhoneInvalid", { defaultValue: "Please enter a valid phone number." });
  if (code.includes("too-many-requests")) return t("m.onboarding.errTooMany", { defaultValue: "Too many attempts. Please try again in a little while." });
  if (code.includes("missing-client-identifier") || code.includes("app-not-authorized") || code.includes("captcha-check-failed") || code.includes("operation-not-allowed")) return t("m.onboarding.errPhoneUnavailable", { defaultValue: "Phone verification is temporarily unavailable. Please try again later." });
  if (code.includes("network")) return t("m.onboarding.errNetwork", { defaultValue: "Network error — check your connection and the API server." });
  return err?.message?.replace(/^Firebase:\s*/, "") || t("m.onboarding.errGeneric", { defaultValue: "Something went wrong. Please try again." });
}

const GOLD = "#bd8752";
const COUNTRIES = [
  { flag: "🇮🇳", code: "+91", name: "India", len: 10 },
  { flag: "🇺🇸", code: "+1", name: "United States", len: 10 },
];
const sub = (s: string) => <Text style={st.sub}>{s}</Text>;

function PrimaryBtn({ label, onPress, disabled, icon }: { label: string; onPress?: () => void; disabled?: boolean; icon?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[{ opacity: disabled ? 0.45 : 1 }]}>
      <LinearGradient colors={["#2b2436", GOLD]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.btn}>
        <Text style={st.btnTxt}>{label}</Text>
        {icon ? <Icon name={icon} size={19} color="#fff" /> : null}
      </LinearGradient>
    </Pressable>
  );
}

function AltBtn({ label, onPress, icon }: { label: string; onPress?: () => void; icon?: string }) {
  return (
    <Pressable onPress={onPress} style={st.altBtn}>
      {icon ? <Icon name={icon} size={18} color="#fff" /> : null}
      <Text style={st.altTxt}>{label}</Text>
    </Pressable>
  );
}

function AuthField({ icon, trailing, ...rest }: { icon: string; trailing?: React.ReactNode } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={st.field}>
      <Icon name={icon} size={18} color="rgba(255,255,255,0.55)" />
      <TextInput placeholderTextColor="rgba(255,255,255,0.4)" style={st.fieldInput} {...rest} />
      {trailing}
    </View>
  );
}

// Must live at module scope: defining this inside OnboardingScreen gives it a new
// identity on every render, which remounts the whole subtree (incl. TextInputs) and
// drops keyboard focus after each keystroke.
function Wrap({ children, scroll }: { children: React.ReactNode; scroll?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient colors={["#2a2531", "#1a1720"]} start={{ x: 0.8, y: 0 }} end={{ x: 0, y: 1 }} style={{ flex: 1 }}>
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        {scroll ? <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>{children}</ScrollView> : children}
      </View>
    </LinearGradient>
  );
}

export function OnboardingScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootParamList>>();
  // language/setLanguage come from the app-wide LanguageContext (i18n +
  // AsyncStorage persistence) — picking a language here must actually apply
  // and survive restarts, not sit in throwaway local state (PUX-003).
  const { t, language, setLanguage } = useLanguage();
  const [step, setStep] = useState("splash");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [suName, setSuName] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPhone, setSuPhone] = useState("");
  const [suPassword, setSuPassword] = useState("");
  // Explicit Terms + Privacy acceptance (clickwrap). Unchecked by default and
  // required — the button stays disabled until the user ticks the box.
  const [suTerms, setSuTerms] = useState(false);
  // 18+ attestation (LEG-003) — its own required checkbox, recorded as a
  // separate 'age_confirmation' consent row (attestation only, no DOB).
  const [suAge18, setSuAge18] = useState(false);
  // Signup keeps its own country selection, independent of the phone-login picker.
  const [suCcIdx, setSuCcIdx] = useState(0);
  const [suCcOpen, setSuCcOpen] = useState(false);
  const suCc = COUNTRIES[suCcIdx];

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [ccIdx, setCcIdx] = useState(0);
  const [ccOpen, setCcOpen] = useState(false);
  const cc = COUNTRIES[ccIdx];

  const { user, signIn, signUp, resetPassword, resendVerificationEmail, sendPhoneOtp, verifyPhoneOtp } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const otpInputRef = useRef<TextInput>(null);
  const [resendPhoneBusy, setResendPhoneBusy] = useState(false);

  // Email-verification resend — was a dead onPress={() => {}} button.
  const [resendBusy, setResendBusy] = useState(false);
  const doResendVerification = async () => {
    if (resendBusy) return;
    setResendBusy(true);
    try {
      const ok = await resendVerificationEmail();
      toast.info(ok
        ? t("m.onboarding.resendSent", { defaultValue: "Verification link sent — check your inbox (and spam)." })
        : t("m.onboarding.resendFailed", { defaultValue: "Couldn't resend the link. Try again in a minute." }));
    } finally {
      setResendBusy(false);
    }
  };

  const done = () => nav.reset({ index: 0, routes: [{ name: "Tabs" }] });

  // Post-LOGIN landing (mirrors web): anyone who owns a listing goes straight
  // to their dashboard, with Tabs (Explore) underneath so back = user side.
  // No listings (or the check fails) → the normal Tabs reset. Signup keeps
  // plain done() — a brand-new account can't own listings.
  const ROLE_FOR: Record<string, string> = { stay: "host", service: "provider", transport: "transport" };
  const doneAfterLogin = async () => {
    try {
      const mine = await fetchMyListings();
      if (mine.length > 0) {
        const role = ROLE_FOR[mine[0]?.listingType] || "provider";
        nav.reset({ index: 1, routes: [{ name: "Tabs" }, { name: "Dashboard", params: { role } }] });
        return;
      }
    } catch { /* offline / slow API — fail open to the Tabs reset */ }
    done();
  };

  const doLogin = async () => {
    setErr(""); setBusy(true);
    try { await signIn(email.trim(), password); await doneAfterLogin(); }
    catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };
  // Signup: create the email/password account, then (while signed in) request a
  // real OTP and LINK the phone to that same account. The linked number reaches
  // the backend via the Firebase phone_number token claim. On a mid-flow retry
  // (the account was created but the SMS send failed), skip re-creating it —
  // otherwise Firebase rejects with email-already-in-use.
  const suE164 = () => `${suCc.code}${suPhone.replace(/\D/g, "").slice(0, suCc.len)}`;
  const doSignup = async () => {
    setErr(""); setBusy(true);
    try {
      const suEmailTrim = suEmail.trim();
      const alreadyCreated = !!user && user.email === suEmailTrim && !user.phone;
      if (!alreadyCreated) {
        await signUp(suEmailTrim, suPassword, suName.trim());
        // Record the versioned Terms + Privacy acceptance and the 18+
        // attestation shown below the button (fire-and-forget — the consent
        // trail is the record; both boxes gate suReady).
        void setConsent("terms", true).catch(() => undefined);
        void setConsent("age_confirmation", true).catch(() => undefined);
      }
      await sendPhoneOtp(suE164());
      setOtp(""); setStep("signupOtp");
    } catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };
  const doVerifyPhoneSignup = async () => {
    setErr(""); setBusy(true);
    try { await verifyPhoneOtp(otp); setOtp(""); setStep("signupEmail"); }
    catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };

  // Phone login: no account is signed in, so verifying the OTP signs the user in.
  const doSendLoginOtp = async () => {
    setErr(""); setBusy(true);
    try { await sendPhoneOtp(`${cc.code}${phone}`); setOtp(""); setStep("otp"); }
    catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };
  const doVerifyLoginOtp = async () => {
    setErr(""); setBusy(true);
    try { await verifyPhoneOtp(otp); await doneAfterLogin(); }
    catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };

  const doResendPhoneOtp = async () => {
    if (resendPhoneBusy) return;
    setResendPhoneBusy(true); setErr("");
    try {
      await sendPhoneOtp(step === "signupOtp" ? suE164() : `${cc.code}${phone}`);
      setOtp("");
      toast.info(t("m.onboarding.otpResent", { defaultValue: "A new code is on its way." }));
    } catch (e) { setErr(authError(e, t)); }
    finally { setResendPhoneBusy(false); }
  };
  const [resetSent, setResetSent] = useState(false);
  const doReset = async () => {
    setErr(""); setBusy(true);
    try { await resetPassword(email.trim()); setResetSent(true); }
    catch (e) { setErr(authError(e, t)); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (step === "splash") {
      const t = setTimeout(() => setStep("language"), 2100);
      return () => clearTimeout(t);
    }
  }, [step]);

  const emailOk = /\S+@\S+\.\S+/.test(email) && password.length >= 1;
  const suDigits = suPhone.replace(/\D/g, "");
  const suReady = suName.trim().length >= 2 && /\S+@\S+\.\S+/.test(suEmail) && suDigits.length === suCc.len && suPassword.length >= 6 && suTerms && suAge18;

  /* ---- SPLASH ---- */
  if (step === "splash") {
    return (
      <Wrap>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 24 }}>
          <View style={st.logoBadge}><LogoMark size={62} /></View>
          <View style={{ alignItems: "center" }}>
            <Text style={st.brand}>IstaSeva</Text>
            <Text style={[st.sub, { marginTop: 8 }]}>{t("m.onboarding.tagline", { defaultValue: "Small-city bookings, made simple" })}</Text>
          </View>
        </View>
        <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 7, paddingBottom: 40 }}>
          <Icon name="mappin" size={15} color="rgba(255,255,255,0.5)" />
          <Text style={st.tiny}>{t("m.onboarding.location", { defaultValue: "Kakinada · East Godavari" })}</Text>
        </View>
      </Wrap>
    );
  }

  /* ---- LANGUAGE ---- */
  if (step === "language") {
    return (
      <Wrap>
        <View style={st.pad}>
          <View style={st.logoBadgeSm}><LogoMark size={40} /></View>
          <Text style={st.h1}>{t("m.onboarding.langTitle", { defaultValue: "Choose your language" })}</Text>
          {sub(t("m.onboarding.langSubtitle", { defaultValue: "మీ భాషను ఎంచుకోండి. You can change this anytime." }))}
        </View>
        <View style={[st.pad, { flex: 1, gap: 11, marginTop: 26 }]}>
          {languages.map((l) => {
            const active = language === l.code;
            return (
              <Pressable key={l.code} onPress={() => setLanguage(l.code)} style={[st.langCard, active && st.langCardActive]}>
                <View style={{ flex: 1 }}>
                  <Text style={st.langNative}>{l.nativeName}</Text>
                  <Text style={st.langEn}>{l.name}</Text>
                </View>
                {active && <Icon name="check" size={22} color={GOLD} strokeWidth={2.4} />}
              </Pressable>
            );
          })}
        </View>
        <View style={[st.pad, { paddingBottom: 20 }]}>
          <PrimaryBtn label={t("m.onboarding.continue", { defaultValue: "Continue" })} icon="arrowR" onPress={() => setStep("login")} />
        </View>
      </Wrap>
    );
  }

  /* ---- LOGIN ---- */
  if (step === "login") {
    return (
      <Wrap scroll>
        <View style={[st.pad, { paddingTop: 16, paddingBottom: 28 }]}>
          <View style={st.logoBadgeSm}><LogoMark size={38} /></View>
          <Text style={st.h1}>{t("m.onboarding.welcomeBack", { defaultValue: "Welcome back" })}</Text>
          {sub(t("m.onboarding.loginSubtitle", { defaultValue: "Log in to manage your bookings, listings and trips." }))}
          <View style={{ gap: 11, marginTop: 24 }}>
            <AuthField icon="mail" placeholder={t("m.onboarding.emailPlaceholder", { defaultValue: "Email address" })} keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
            <AuthField
              icon="lock" placeholder={t("m.onboarding.passwordPlaceholder", { defaultValue: "Password" })} secureTextEntry={!showPw} value={password} onChangeText={setPassword}
              trailing={<Pressable onPress={() => setShowPw((s) => !s)}><Icon name={showPw ? "eyeOff" : "eye"} size={18} color="rgba(255,255,255,0.55)" /></Pressable>}
            />
          </View>
          <Pressable onPress={() => setStep("forgot")} style={{ alignSelf: "flex-end", marginTop: 10 }}>
            <Text style={st.link}>{t("m.onboarding.forgotPassword", { defaultValue: "Forgot password?" })}</Text>
          </Pressable>
          <View style={{ marginTop: 20 }}>
            <PrimaryBtn label={busy ? t("m.onboarding.signingIn", { defaultValue: "Signing in…" }) : t("m.onboarding.signIn", { defaultValue: "Sign in" })} icon="arrowR" disabled={!emailOk || busy} onPress={doLogin} />
            {err ? <Text style={st.errTxt}>{err}</Text> : null}
          </View>
          <View style={st.divider}><View style={st.divLine} /><Text style={st.divTxt}>{t("m.onboarding.or", { defaultValue: "OR" })}</Text><View style={st.divLine} /></View>
          <AltBtn label={t("m.onboarding.continueWithPhone", { defaultValue: "Continue with phone" })} icon="phone" onPress={() => { setOtp(""); setStep("phone"); }} />

          <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 22 }}>
            <Text style={st.foot}>{t("m.onboarding.newToApp", { defaultValue: "New to IstaSeva? " })}</Text>
            <Pressable onPress={() => setStep("signup")}><Text style={st.linkStrong}>{t("m.onboarding.createAccount", { defaultValue: "Create account" })}</Text></Pressable>
          </View>
        </View>
      </Wrap>
    );
  }

  /* ---- SIGNUP ---- */
  if (step === "signup") {
    return (
      <Wrap scroll>
        <View style={[st.pad, { paddingTop: 16, paddingBottom: 28 }]}>
          <Text style={st.h1}>{t("m.onboarding.createTitle", { defaultValue: "Create your account" })}</Text>
          {sub(t("m.onboarding.signupSubtitle", { defaultValue: "Join IstaSeva to book stays, services and rides." }))}
          <View style={{ gap: 11, marginTop: 24 }}>
            <AuthField icon="user" placeholder={t("m.onboarding.fullNamePlaceholder", { defaultValue: "Full name" })} value={suName} onChangeText={setSuName} />
            <AuthField icon="mail" placeholder={t("m.onboarding.emailPlaceholder", { defaultValue: "Email address" })} keyboardType="email-address" autoCapitalize="none" value={suEmail} onChangeText={setSuEmail} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable style={st.suCcBtn} onPress={() => setSuCcOpen(true)}>
                <Text style={st.ccFlag}>{suCc.flag}</Text>
                <Text style={st.suCcCode}>{suCc.code}</Text>
                <Icon name="chevD" size={14} color="rgba(255,255,255,0.6)" />
              </Pressable>
              <View style={[st.field, { flex: 1 }]}>
                <Icon name="phone" size={18} color="rgba(255,255,255,0.55)" />
                <TextInput
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={st.fieldInput}
                  placeholder={t("m.onboarding.mobilePlaceholder", { defaultValue: "Mobile number" })}
                  keyboardType="phone-pad"
                  maxLength={suCc.len}
                  value={suPhone}
                  onChangeText={(v: string) => setSuPhone(v.replace(/[^\d]/g, "").slice(0, suCc.len))}
                />
              </View>
            </View>
            <AuthField
              icon="lock" placeholder={t("m.onboarding.passwordMinPlaceholder", { defaultValue: "Password (min 6 characters)" })} secureTextEntry={!showPw} value={suPassword} onChangeText={setSuPassword}
              trailing={<Pressable onPress={() => setShowPw((s) => !s)}><Icon name={showPw ? "eyeOff" : "eye"} size={18} color="rgba(255,255,255,0.55)" /></Pressable>}
            />
          </View>
          <View style={st.note}>
            <Icon name="info" size={14} color="rgba(255,255,255,0.55)" />
            <Text style={st.noteTxt}>{t("m.onboarding.guestNote", { defaultValue: "You'll start as a guest. Become a host, provider or driver anytime from your dashboard." })}</Text>
          </View>
          <View style={{ marginTop: 20 }}>
            <PrimaryBtn label={busy ? t("m.onboarding.creating", { defaultValue: "Creating…" }) : t("m.onboarding.createAccount", { defaultValue: "Create account" })} icon="arrowR" disabled={!suReady || busy} onPress={doSignup} />
            {err ? <Text style={st.errTxt}>{err}</Text> : null}
            {/* Explicit Terms + Privacy consent (LEG-001). Ticking the box is
                required (gates suReady) and creating the account records a
                'terms' consent row on the trail. */}
            <View style={st.cbRow}>
              <Pressable
                onPress={() => setSuTerms((v) => !v)}
                hitSlop={8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: suTerms }}
                style={[st.cbBox, suTerms && st.cbBoxOn]}
              >
                {suTerms ? <Icon name="check" size={13} color="#1c1108" /> : null}
              </Pressable>
              <Text style={st.cbLabel}>
                <Text onPress={() => setSuTerms((v) => !v)}>
                  {t("m.onboarding.termsLead", { defaultValue: "I agree to the " })}
                </Text>
                <Text style={[st.linkStrong, { fontSize: 12.5 }]} onPress={() => nav.navigate("Terms")}>
                  {t("m.onboarding.termsLink", { defaultValue: "Terms of Service" })}
                </Text>
                {t("m.onboarding.termsAnd", { defaultValue: " and " })}
                <Text style={[st.linkStrong, { fontSize: 12.5 }]} onPress={() => nav.navigate("PrivacyPolicy")}>
                  {t("m.onboarding.privacyLink", { defaultValue: "Privacy Policy" })}
                </Text>
              </Text>
            </View>
            {/* 18+ attestation (LEG-003): separate box so the consent trail
                shows which representation the user made. */}
            <View style={st.cbRow}>
              <Pressable
                onPress={() => setSuAge18((v) => !v)}
                hitSlop={8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: suAge18 }}
                style={[st.cbBox, suAge18 && st.cbBoxOn]}
              >
                {suAge18 ? <Icon name="check" size={13} color="#1c1108" /> : null}
              </Pressable>
              <Text style={st.cbLabel} onPress={() => setSuAge18((v) => !v)}>
                {t("m.onboarding.ageAttest", { defaultValue: "I confirm that I am 18 years of age or older" })}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 22 }}>
            <Text style={st.foot}>{t("m.onboarding.haveAccount", { defaultValue: "Already have an account? " })}</Text>
            <Pressable onPress={() => setStep("login")}><Text style={st.linkStrong}>{t("m.onboarding.logIn", { defaultValue: "Log in" })}</Text></Pressable>
          </View>
        </View>

        {/* country picker — same bottom-sheet as the phone-login step */}
        <Modal visible={suCcOpen} transparent animationType="fade" onRequestClose={() => setSuCcOpen(false)}>
          <Pressable style={st.ccBackdrop} onPress={() => setSuCcOpen(false)} />
          <View style={st.ccSheet}>
            <View style={st.ccHandle} />
            <Text style={st.ccSheetTitle}>{t("m.onboarding.selectCountry", { defaultValue: "Select country" })}</Text>
            {COUNTRIES.map((c, i) => (
              <Pressable key={c.code} style={[st.ccItem, i === suCcIdx && st.ccItemOn]} onPress={() => { setSuCcIdx(i); setSuPhone(""); setSuCcOpen(false); }}>
                <Text style={st.ccFlag}>{c.flag}</Text>
                <Text style={st.ccItemTxt}>{t(`m.onboarding.country.${c.code}`, { defaultValue: c.name })}</Text>
                <Text style={st.ccItemCode}>{c.code}</Text>
                {i === suCcIdx && <Icon name="check" size={18} color={GOLD} strokeWidth={2.4} />}
              </Pressable>
            ))}
          </View>
        </Modal>
      </Wrap>
    );
  }

  /* ---- FORGOT ---- */
  if (step === "forgot") {
    return (
      <Wrap>
        <View style={[st.pad, { paddingTop: 8 }]}>
          <Pressable onPress={() => setStep("login")} style={{ marginLeft: -8 }}><Icon name="chevL" size={24} color="#fff" /></Pressable>
          <Text style={[st.h1, { marginTop: 18 }]}>{t("m.onboarding.resetTitle", { defaultValue: "Reset your password" })}</Text>
          {sub(t("m.onboarding.resetSubtitle", { defaultValue: "Enter your email and we'll send you a reset link." }))}
          <View style={{ marginTop: 24 }}>
            <AuthField icon="mail" placeholder={t("m.onboarding.emailPlaceholder", { defaultValue: "Email address" })} keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
          </View>
          {resetSent ? (
            <View style={[st.note, { marginTop: 16 }]}>
              <Icon name="check" size={14} color="#9ad6a8" />
              <Text style={[st.noteTxt, { color: "#9ad6a8" }]}>{t("m.onboarding.resetSent", { defaultValue: "Reset link sent to {{email}}. Check your inbox.", email })}</Text>
            </View>
          ) : null}
          {err ? <Text style={[st.errTxt, { paddingHorizontal: 0 }]}>{err}</Text> : null}
        </View>
        <View style={{ flex: 1 }} />
        <View style={[st.pad, { paddingBottom: 20 }]}>
          <PrimaryBtn label={busy ? t("m.onboarding.sending", { defaultValue: "Sending…" }) : resetSent ? t("m.onboarding.resendLink", { defaultValue: "Resend link" }) : t("m.onboarding.sendResetLink", { defaultValue: "Send reset link" })} icon="arrowR" disabled={!/\S+@\S+\.\S+/.test(email) || busy} onPress={doReset} />
        </View>
      </Wrap>
    );
  }

  /* ---- PHONE (dialpad) ---- */
  if (step === "phone") {
    return (
      <Wrap>
        <View style={[st.pad, { paddingTop: 8 }]}>
          <Pressable onPress={() => { setCcOpen(false); setStep("login"); }} style={{ marginLeft: -8 }}><Icon name="chevL" size={24} color="#fff" /></Pressable>
          <Text style={[st.h1, { marginTop: 14 }]}>{t("m.onboarding.continueWithPhone", { defaultValue: "Continue with phone" })}</Text>
          {sub(t("m.onboarding.phoneSubtitle", { defaultValue: "We'll send a 6-digit code to verify it's you." }))}
          <View style={st.phoneRow}>
            <Pressable style={st.ccBtn} onPress={() => setCcOpen(true)}>
              <Text style={st.ccFlag}>{cc.flag}</Text>
              <Text style={st.cc}>{cc.code}</Text>
              <Icon name="chevD" size={15} color="rgba(255,255,255,0.6)" />
            </Pressable>
            <TextInput
              style={st.phoneInput}
              value={phone}
              onChangeText={(v) => setPhone(v.replace(/[^\d]/g, "").slice(0, cc.len))}
              placeholder={t("m.onboarding.phoneNumberPlaceholder", { defaultValue: "Phone number" })}
              placeholderTextColor="rgba(255,255,255,0.32)"
              keyboardType="phone-pad"
              autoFocus
              maxLength={cc.len}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center", marginTop: 14 }}>
            <Icon name="shield" size={15} color="rgba(255,255,255,0.42)" />
            <Text style={[st.tiny, { fontSize: 12 }]}>{t("m.onboarding.privacyNote", { defaultValue: "Your number stays private. OTP login only." })}</Text>
          </View>
        </View>
        <View style={{ flex: 1 }} />
        <View style={[st.pad, { paddingBottom: 16 }]}>
          <PrimaryBtn label={busy ? t("m.onboarding.sending", { defaultValue: "Sending…" }) : t("m.onboarding.sendCode", { defaultValue: "Send code" })} icon="arrowR" disabled={phone.length !== cc.len || busy} onPress={() => { setCcOpen(false); void doSendLoginOtp(); }} />
          {err ? <Text style={st.errTxt}>{err}</Text> : null}
        </View>

        {/* country picker — a Modal so touches always register (an inline
            absolute dropdown overflows its parent and isn't tappable on iOS) */}
        <Modal visible={ccOpen} transparent animationType="fade" onRequestClose={() => setCcOpen(false)}>
          <Pressable style={st.ccBackdrop} onPress={() => setCcOpen(false)} />
          <View style={st.ccSheet}>
            <View style={st.ccHandle} />
            <Text style={st.ccSheetTitle}>{t("m.onboarding.selectCountry", { defaultValue: "Select country" })}</Text>
            {COUNTRIES.map((c, i) => (
              <Pressable key={c.code} style={[st.ccItem, i === ccIdx && st.ccItemOn]} onPress={() => { setCcIdx(i); setPhone(""); setCcOpen(false); }}>
                <Text style={st.ccFlag}>{c.flag}</Text>
                <Text style={st.ccItemTxt}>{t(`m.onboarding.country.${c.code}`, { defaultValue: c.name })}</Text>
                <Text style={st.ccItemCode}>{c.code}</Text>
                {i === ccIdx && <Icon name="check" size={18} color={GOLD} strokeWidth={2.4} />}
              </Pressable>
            ))}
          </View>
        </Modal>
      </Wrap>
    );
  }

  /* ---- OTP ---- */
  if (step === "otp" || step === "signupOtp") {
    const isSignup = step === "signupOtp";
    const ph = isSignup ? suPhone : phone;
    const dialCode = isSignup ? suCc.code : cc.code;
    return (
      <Wrap>
        <View style={[st.pad, { paddingTop: 8 }]}>
          <Pressable onPress={() => { setErr(""); setStep(isSignup ? "signup" : "phone"); }} style={{ marginLeft: -8 }}><Icon name="chevL" size={24} color="#fff" /></Pressable>
          <Text style={[st.h1, { marginTop: 18 }]}>{isSignup ? t("m.onboarding.verifyPhoneTitle", { defaultValue: "Verify your phone" }) : t("m.onboarding.verifyNumberTitle", { defaultValue: "Verify your number" })}</Text>
          {sub(t("m.onboarding.otpSubtitle", { defaultValue: "Enter the 6-digit code sent to {{number}}", number: `${dialCode} ${ph.replace(/(\d{5})(\d)/, "$1 $2")}` }))}
          {/* Editable OTP: six boxes visually, a single transparent TextInput
              overlaid on top captures input and drives them. */}
          <Pressable style={st.otpWrap} onPress={() => otpInputRef.current?.focus()}>
            <View style={st.otpRow} pointerEvents="none">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={[st.otpBox, !!otp[i] && st.otpFilled]}>
                  <Text style={st.otpTxt}>{otp[i] || ""}</Text>
                </View>
              ))}
            </View>
            <TextInput
              ref={otpInputRef}
              style={st.otpHiddenInput}
              value={otp}
              onChangeText={(v) => setOtp(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              caretHidden
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
            />
          </Pressable>
          <View style={{ marginTop: 24 }}>
            <PrimaryBtn
              label={busy ? t("m.onboarding.verifying", { defaultValue: "Verifying…" }) : t("m.onboarding.verify", { defaultValue: "Verify" })}
              icon="check"
              disabled={otp.length !== 6 || busy}
              onPress={() => (isSignup ? void doVerifyPhoneSignup() : void doVerifyLoginOtp())}
            />
            {err ? <Text style={st.errTxt}>{err}</Text> : null}
          </View>
          <Pressable onPress={() => void doResendPhoneOtp()} disabled={resendPhoneBusy} style={{ alignSelf: "center", marginTop: 18 }}>
            <Text style={st.link}>{resendPhoneBusy ? t("m.onboarding.sending", { defaultValue: "Sending…" }) : t("m.onboarding.resendCode", { defaultValue: "Didn't get it? Resend code" })}</Text>
          </Pressable>
        </View>
      </Wrap>
    );
  }

  /* ---- EMAIL VERIFY ---- */
  if (step === "signupEmail") {
    return (
      <Wrap>
        <View style={[st.pad, { paddingTop: 18 }]}>
          <View style={st.logoBadgeSm}><Icon name="mail" size={30} color="#f7e8d7" /></View>
          <Text style={st.h1}>{t("m.onboarding.verifyEmailTitle", { defaultValue: "Verify your email" })}</Text>
          {sub(t("m.onboarding.verifyEmailSubtitle", { defaultValue: "Phone verified. We've sent a verification link to {{email}} — tap it to activate your account.", email: suEmail || t("m.onboarding.yourEmail", { defaultValue: "your email" }) }))}
          <View style={{ gap: 11, marginTop: 24 }}>
            <View style={st.vRow}>
              <View style={[st.vIco, { backgroundColor: "rgba(47,125,85,0.25)" }]}><Icon name="check" size={18} color="#9ad6a8" strokeWidth={2.6} /></View>
              <View style={{ flex: 1 }}><Text style={st.vStrong}>{t("m.onboarding.phoneLabel", { defaultValue: "Phone number" })}</Text><Text style={st.vSub}>{t("m.onboarding.verifiedByOtp", { defaultValue: "Verified by OTP" })}</Text></View>
            </View>
            <View style={st.vRow}>
              <View style={[st.vIco, { backgroundColor: "rgba(189,135,82,0.25)" }]}><Icon name="mail" size={18} color="#e7c39c" /></View>
              <View style={{ flex: 1 }}><Text style={st.vStrong}>{t("m.onboarding.emailLabel", { defaultValue: "Email address" })}</Text><Text style={st.vSub}>{t("m.onboarding.waitingForTap", { defaultValue: "Waiting for you to tap the link" })}</Text></View>
              <Icon name="refresh" size={15} color="rgba(255,255,255,0.5)" />
            </View>
          </View>
        </View>
        <View style={{ flex: 1 }} />
        <View style={[st.pad, { paddingBottom: 20, gap: 12 }]}>
          <PrimaryBtn label={t("m.onboarding.verifiedMyEmail", { defaultValue: "I've verified my email" })} icon="check" onPress={done} />
          <AltBtn label={resendBusy ? t("m.onboarding.sending", { defaultValue: "Sending…" }) : t("m.onboarding.resendLink", { defaultValue: "Resend link" })} onPress={doResendVerification} />
        </View>
      </Wrap>
    );
  }

  return null;
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: 28 },
  h1: { fontSize: 27, fontFamily: font.head, color: "#fff", marginTop: 18, letterSpacing: -0.3 },
  brand: { fontSize: 38, fontFamily: font.headHeavy, color: "#fff", letterSpacing: -0.8 },
  sub: { color: "rgba(255,255,255,0.6)", marginTop: 7, fontFamily: font.body, fontSize: 14, lineHeight: 20 },
  tiny: { color: "rgba(255,255,255,0.5)", fontFamily: font.bodySemi, fontSize: 12.5 },
  logoBadge: { width: 96, height: 96, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
  logoBadgeSm: { width: 76, height: 76, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },

  btn: { minHeight: 56, borderRadius: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  btnTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
  altBtn: { minHeight: 52, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  altTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 15 },
  errTxt: { color: "#f3a5ad", fontFamily: font.bodySemi, fontSize: 13, marginTop: 12, textAlign: "center" },
  demoBtn: { flex: 1, alignItems: "center", gap: 6, paddingVertical: 12, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.16)" },
  demoTxt: { color: "#fff", fontFamily: font.bodyBold, fontSize: 12.5 },

  field: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 15, height: 54, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.16)", backgroundColor: "rgba(255,255,255,0.08)" },
  fieldInput: { flex: 1, color: "#fff", fontSize: 15.5, fontFamily: font.bodySemi, paddingVertical: 0, ...noOutline },
  suCcBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: 54, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.16)", backgroundColor: "rgba(255,255,255,0.08)" },
  suCcCode: { fontFamily: font.bodyHeavy, fontSize: 15, color: "#fff" },

  link: { color: "rgba(255,255,255,0.62)", fontSize: 13, fontFamily: font.bodyBold },
  linkStrong: { color: "#e7c39c", fontSize: 13.5, fontFamily: font.bodyHeavy },
  foot: { color: "rgba(255,255,255,0.6)", fontSize: 13.5, fontFamily: font.body },
  cbRow: { flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 14, paddingHorizontal: 2 },
  cbBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.4)", alignItems: "center", justifyContent: "center", marginTop: 1 },
  cbBoxOn: { backgroundColor: "#e7c39c", borderColor: "#e7c39c" },
  cbLabel: { flex: 1, color: "rgba(255,255,255,0.72)", fontSize: 12.5, lineHeight: 18, fontFamily: font.body },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 20 },
  divLine: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.14)" },
  divTxt: { color: "rgba(255,255,255,0.4)", fontSize: 12, fontFamily: font.bodyBold, letterSpacing: 0.6 },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginTop: 16 },
  noteTxt: { color: "rgba(255,255,255,0.55)", fontSize: 12.5, lineHeight: 18, flex: 1, fontFamily: font.body },

  langCard: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16, paddingHorizontal: 18, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.16)", backgroundColor: "rgba(255,255,255,0.08)" },
  langCardActive: { borderColor: "rgba(189,135,82,0.7)", backgroundColor: "rgba(189,135,82,0.14)" },
  langNative: { fontFamily: font.head, fontSize: 19, color: "#fff" },
  langEn: { color: "rgba(255,255,255,0.6)", fontSize: 12.5, fontFamily: font.body, marginTop: 1 },

  phoneField: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, minHeight: 60, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(255,255,255,0.08)", marginTop: 24 },
  cc: { fontFamily: font.bodyHeavy, fontSize: 17, color: "#fff" },
  phoneVal: { flex: 1, color: "#fff", fontSize: 19, fontFamily: font.bodyBold, letterSpacing: 1 },
  phoneRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 24, zIndex: 20 },
  ccBtn: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 14, minHeight: 60, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(255,255,255,0.08)" },
  ccFlag: { fontSize: 18 },
  ccBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  ccSheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: "#241f2e", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 36, borderTopWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  ccHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)", marginBottom: 14 },
  ccSheetTitle: { color: "rgba(255,255,255,0.55)", fontFamily: font.bodyHeavy, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, marginLeft: 4 },
  ccItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 16, borderRadius: 14 },
  ccItemOn: { backgroundColor: "rgba(189,135,82,0.18)" },
  ccItemTxt: { flex: 1, color: "#fff", fontFamily: font.bodyBold, fontSize: 15.5 },
  ccItemCode: { color: "rgba(255,255,255,0.6)", fontFamily: font.bodyBold, fontSize: 14.5 },
  phoneInput: { flex: 1, color: "#fff", fontSize: 19, fontFamily: font.bodyBold, letterSpacing: 1, paddingHorizontal: 18, minHeight: 60, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(255,255,255,0.08)" },
  dialpad: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  key: { width: "31.5%", height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  keyFn: { width: "31.5%", height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  keyTxt: { fontSize: 22, fontFamily: font.head, color: "#fff" },

  otpWrap: { position: "relative" },
  // Invisible via transparent text/bg (NOT opacity:0 — an opacity-0 TextInput
  // fails to take focus / raise the keyboard on some Android/iOS setups, which
  // showed up as "can't type in the OTP boxes"). The caret is hidden and the
  // digits render in the boxes behind, so this input stays visually invisible
  // while remaining reliably focusable/typeable.
  otpHiddenInput: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, color: "transparent", backgroundColor: "transparent", textAlign: "center", ...noOutline },
  otpRow: { flexDirection: "row", gap: 8, justifyContent: "center", marginTop: 24 },
  otpBox: { width: 46, height: 58, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)", backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center" },
  otpFilled: { borderColor: "rgba(189,135,82,0.7)", backgroundColor: "rgba(189,135,82,0.14)" },
  otpTxt: { fontSize: 24, fontFamily: font.headHeavy, color: "#fff" },

  vRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 15, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.14)", backgroundColor: "rgba(255,255,255,0.06)" },
  vIco: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  vStrong: { fontSize: 14.5, fontFamily: font.bodyBold, color: "#fff" },
  vSub: { fontSize: 12.5, color: "rgba(255,255,255,0.55)", marginTop: 1, fontFamily: font.body },
});
