// design/screens/ResetPasswordScreen.tsx — completion side of the forgot-password
// flow. Reached via the emailed deep link (istaseva://reset-password?oobCode=…
// or the App/Universal Link). Validates the oobCode, then sets a new password
// through the Firebase client SDK. Dark aesthetic mirrors OnboardingScreen.
import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../Icon";
import { font } from "../theme";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

const GOLD = "#bd8752";
const MIN_LEN = 6;
type Phase = "verifying" | "invalid" | "ready" | "done";

function PrimaryBtn({ label, onPress, disabled }: any) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={{ opacity: disabled ? 0.45 : 1 }}>
      <LinearGradient colors={["#2b2436", GOLD]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.btn}>
        <Text style={st.btnTxt}>{label}</Text>
        <Icon name="arrowR" size={19} color="#fff" />
      </LinearGradient>
    </Pressable>
  );
}

function Field({ icon, trailing, ...rest }: any) {
  return (
    <View style={st.field}>
      <Icon name={icon} size={18} color="rgba(255,255,255,0.55)" />
      <TextInput placeholderTextColor="rgba(255,255,255,0.4)" style={st.fieldInput} {...rest} />
      {trailing}
    </View>
  );
}

export function ResetPasswordScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { verifyResetCode, confirmReset, notifyPasswordChanged } = useAuth();

  const oobCode: string = route.params?.oobCode ?? "";

  const [phase, setPhase] = useState<Phase>("verifying");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    if (!oobCode) { setPhase("invalid"); return; }
    verifyResetCode(oobCode)
      .then((addr) => { if (active) { setEmail(addr || ""); setPhase("ready"); } })
      .catch(() => { if (active) setPhase("invalid"); });
    return () => { active = false; };
  }, [oobCode]);

  const canSubmit = pw.length >= MIN_LEN && pw === confirm && !busy;

  const doReset = async () => {
    setErr("");
    if (pw.length < MIN_LEN) { setErr(t("m.reset.errShort", { defaultValue: "Password must be at least 6 characters." })); return; }
    if (pw !== confirm) { setErr(t("m.reset.errMismatch", { defaultValue: "Passwords don't match." })); return; }
    setBusy(true);
    try {
      await confirmReset(oobCode, pw);
      // Best-effort security audit + alert email. Fire-and-forget.
      void notifyPasswordChanged(email);
      setPhase("done");
    } catch (e: any) {
      if (String(e?.code || "").includes("expired-action-code")) setPhase("invalid");
      else setErr(t("m.reset.errGeneric", { defaultValue: "Couldn't reset your password. Please try again." }));
    } finally {
      setBusy(false);
    }
  };

  const toLogin = () => nav.reset({ index: 0, routes: [{ name: "Onboarding" }] });

  return (
    <LinearGradient colors={["#2a2531", "#1a1720"]} start={{ x: 0.8, y: 0 }} end={{ x: 0, y: 1 }} style={{ flex: 1 }}>
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20 }}>
        <View style={st.pad}>
          <Pressable onPress={toLogin} style={{ marginLeft: -8 }}>
            <Icon name="chevL" size={24} color="#fff" />
          </Pressable>

          {phase === "verifying" && (
            <View style={{ marginTop: 60, alignItems: "center", gap: 16 }}>
              <ActivityIndicator color={GOLD} />
              <Text style={st.sub}>{t("m.reset.verifying", { defaultValue: "Verifying your reset link…" })}</Text>
            </View>
          )}

          {phase === "invalid" && (
            <View style={{ marginTop: 40 }}>
              <Text style={st.h1}>{t("m.reset.invalidTitle", { defaultValue: "Link expired or invalid" })}</Text>
              <Text style={st.sub}>{t("m.reset.invalidSubtitle", { defaultValue: "This reset link is no longer valid. Reset links expire after 1 hour and can only be used once. Request a new one from the login screen." })}</Text>
              <View style={{ marginTop: 28 }}>
                <PrimaryBtn label={t("m.reset.toLogin", { defaultValue: "Back to login" })} onPress={toLogin} />
              </View>
            </View>
          )}

          {phase === "ready" && (
            <View style={{ marginTop: 18 }}>
              <Text style={st.h1}>{t("m.reset.title", { defaultValue: "Set a new password" })}</Text>
              <Text style={st.sub}>{t("m.reset.subtitle", { defaultValue: "Choose a new password for your account." })}</Text>
              <View style={{ gap: 11, marginTop: 24 }}>
                <Field
                  icon="lock" placeholder={t("m.reset.newPlaceholder", { defaultValue: "New password (min 6 characters)" })}
                  secureTextEntry={!showPw} value={pw} onChangeText={setPw} autoCapitalize="none"
                  trailing={<Pressable onPress={() => setShowPw((s) => !s)}><Icon name={showPw ? "eyeOff" : "eye"} size={18} color="rgba(255,255,255,0.55)" /></Pressable>}
                />
                <Field
                  icon="lock" placeholder={t("m.reset.confirmPlaceholder", { defaultValue: "Confirm new password" })}
                  secureTextEntry={!showPw} value={confirm} onChangeText={setConfirm} autoCapitalize="none"
                />
              </View>
              {err ? <Text style={st.errTxt}>{err}</Text> : null}
              <View style={{ marginTop: 22 }}>
                <PrimaryBtn label={busy ? t("m.reset.saving", { defaultValue: "Saving…" }) : t("m.reset.save", { defaultValue: "Reset password" })} disabled={!canSubmit} onPress={doReset} />
              </View>
            </View>
          )}

          {phase === "done" && (
            <View style={{ marginTop: 40 }}>
              <View style={st.check}><Icon name="check" size={30} color="#9ad6a8" /></View>
              <Text style={st.h1}>{t("m.reset.doneTitle", { defaultValue: "Password updated" })}</Text>
              <Text style={st.sub}>{t("m.reset.doneSubtitle", { defaultValue: "Your password has been reset. Log in with your new password." })}</Text>
              <View style={{ marginTop: 28 }}>
                <PrimaryBtn label={t("m.reset.toLogin", { defaultValue: "Go to login" })} onPress={toLogin} />
              </View>
            </View>
          )}
        </View>
      </View>
    </LinearGradient>
  );
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: 24 },
  h1: { color: "#fff", fontSize: 27, fontFamily: font.head, letterSpacing: -0.3, marginTop: 8 },
  sub: { color: "rgba(255,255,255,0.6)", fontSize: 14, fontFamily: font.body, lineHeight: 20, marginTop: 7 },
  field: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", borderRadius: 14, paddingHorizontal: 14, height: 52 },
  fieldInput: { flex: 1, color: "#fff", fontSize: 15.5, fontFamily: font.bodySemi },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 54, borderRadius: 15 },
  btnTxt: { color: "#fff", fontSize: 16, fontFamily: font.bodyHeavy },
  errTxt: { color: "#f3a5ad", fontSize: 13, fontFamily: font.bodySemi, marginTop: 12 },
  check: { width: 60, height: 60, borderRadius: 999, backgroundColor: "rgba(154,214,168,0.12)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
});
