// design/screens/KycVerificationScreen.tsx — identity verification (modeled on web ProviderVerification.tsx).
// Document upload cards with real image picking (expo-image-picker) + real backend upload (Phase 4).
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, Image, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { Icon } from "../Icon";
import { AppBar } from "../primitives";
import { Background } from "../Background";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { fetchKycDocuments, uploadKycDocument } from "../api/verification";

type DocType = { type: string; label: string; description: string; icon: string; required: boolean };
const DOCS: DocType[] = [
  { type: "aadhaar", label: "Aadhaar Card", description: "Government-issued identity (mandatory).", icon: "badge", required: true },
  { type: "pan_card", label: "PAN Card", description: "Tax identification (recommended).", icon: "card", required: false },
  { type: "driving_license", label: "Driving Licence", description: "Required for transport providers.", icon: "car", required: false },
  { type: "passport", label: "Passport", description: "International identity document.", icon: "globe", required: false },
  { type: "voter_id", label: "Voter ID", description: "Alternative government ID.", icon: "user", required: false },
];

const STATUS: Record<string, { label: string; bg: string; fg: string; icon: string }> = {
  pending: { label: "Not started", bg: "rgba(58,50,71,0.08)", fg: T.muted, icon: "info" },
  submitted: { label: "Under review", bg: "rgba(189,135,82,0.16)", fg: "#8b5e4a", icon: "clock" },
  verified: { label: "Verified", bg: "rgba(47,125,85,0.12)", fg: "#2f7d55", icon: "badge" },
};

// Per-document state: a local preview uri (just picked) and/or a server status.
type DocState = { uri?: string; status?: string; busy?: boolean };

export function KycVerificationScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [docs, setDocs] = useState<Record<string, DocState>>({});

  // Hydrate previously-submitted documents from the backend (signed-in users).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    fetchKycDocuments()
      .then((rows) => {
        if (!alive) return;
        const next: Record<string, DocState> = {};
        // Keep the latest doc per type (rows arrive newest-first).
        for (const d of rows) if (!next[d.type]) next[d.type] = { uri: d.fileUrl, status: d.status };
        setDocs(next);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [user]);

  const aadhaar = docs["aadhaar"];
  const overall = aadhaar?.status === "approved" ? "verified" : aadhaar?.uri ? "submitted" : "pending";
  const st = STATUS[overall];

  const pick = async (docType: string) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.canAskAgain === false) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    const prev = docs[docType];

    // Optimistic local preview while we upload.
    setDocs((p) => ({ ...p, [docType]: { uri: asset.uri, status: "pending", busy: !!user } }));

    if (!user) return; // demo mode — keep the local preview only

    try {
      const saved = await uploadKycDocument({
        userId: user.id,
        documentType: docType,
        uri: asset.uri,
        mimeType: (asset as any).mimeType,
      });
      setDocs((p) => ({ ...p, [docType]: { uri: saved.fileUrl, status: saved.status } }));
    } catch (e: any) {
      setDocs((p) => ({ ...p, [docType]: prev || {} }));
      Alert.alert(
        t("m.kyc.uploadFailedTitle", { defaultValue: "Upload failed" }),
        e?.response?.data?.error?.message || e?.message || t("m.kyc.uploadFailedMsg", { defaultValue: "Could not upload the document. Please try again." }),
      );
    }
  };

  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.kyc.title", { defaultValue: "Identity verification" })} sub={t("m.kyc.subtitle", { defaultValue: "Verify to start taking bookings" })} onBack={() => nav.goBack()} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* status card */}
        <View style={s.statusCard}>
          <View style={[s.statusIco, { backgroundColor: st.bg }]}><Icon name={st.icon} size={22} color={st.fg} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.statusTitle}>{t(`m.kyc.status.${overall}`, { defaultValue: st.label })}</Text>
            <Text style={s.statusSub}>
              {overall === "submitted"
                ? t("m.kyc.statusSubReviewing", { defaultValue: "We're reviewing your documents — usually within a few hours." })
                : t("m.kyc.statusSubUpload", { defaultValue: "Upload your Aadhaar (and a Driving Licence for transport) to go live." })}
            </Text>
          </View>
        </View>

        <Text style={s.sec}>{t("m.kyc.yourDocuments", { defaultValue: "Your documents" })}</Text>
        <View style={{ gap: 12 }}>
          {DOCS.map((doc) => {
            const state = docs[doc.type] || {};
            const uri = state.uri;
            const approved = state.status === "approved";
            const rejected = state.status === "rejected";
            const sub = state.busy
              ? t("m.kyc.subUploading", { defaultValue: "Uploading…" })
              : rejected
                ? t("m.kyc.subRejected", { defaultValue: "Rejected — please re-upload" })
                : approved
                  ? t("m.kyc.subVerified", { defaultValue: "Verified · JPG/PNG" })
                  : t("m.kyc.subUnderReview", { defaultValue: "Under review · JPG/PNG" });
            return (
              <View key={doc.type} style={s.docCard}>
                <View style={s.docHead}>
                  <View style={s.docIco}><Icon name={doc.icon} size={20} color={T.aubergine} /></View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={s.docLabel}>{t(`m.kyc.doc.${doc.type}.label`, { defaultValue: doc.label })}</Text>
                      {doc.required && <View style={s.reqBadge}><Text style={s.reqTxt}>{t("m.kyc.required", { defaultValue: "Required" })}</Text></View>}
                    </View>
                    <Text style={s.docDesc}>{t(`m.kyc.doc.${doc.type}.description`, { defaultValue: doc.description })}</Text>
                  </View>
                  {uri && !rejected && (
                    <View style={s.doneChip}>
                      <Icon name="checkSm" size={12} color="#2f7d55" strokeWidth={2.6} />
                      <Text style={s.doneTxt}>{approved ? t("m.kyc.chipVerified", { defaultValue: "Verified" }) : t("m.kyc.chipUploaded", { defaultValue: "Uploaded" })}</Text>
                    </View>
                  )}
                </View>
                {uri ? (
                  <View style={s.previewRow}>
                    <Image source={{ uri }} style={s.preview} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.previewTitle}>{state.busy ? t("m.kyc.previewUploading", { defaultValue: "Uploading document…" }) : t("m.kyc.previewUploaded", { defaultValue: "Document uploaded" })}</Text>
                      <Text style={[s.previewSub, rejected && { color: T.coral }]}>{sub}</Text>
                    </View>
                    {state.busy ? (
                      <ActivityIndicator color={T.terra} style={{ marginRight: 6 }} />
                    ) : (
                      <Pressable onPress={() => pick(doc.type)} style={({ pressed }: any) => [s.replaceBtn, pressed && { opacity: 0.8 }]}>
                        <Text style={s.replaceTxt}>{t("m.kyc.replace", { defaultValue: "Replace" })}</Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <Pressable onPress={() => pick(doc.type)} style={({ pressed, hovered }: any) => [s.uploadBtn, hovered && { borderColor: "rgba(139,94,74,0.5)", backgroundColor: "rgba(189,135,82,0.06)" }, pressed && { opacity: 0.8 }]}>
                    <Icon name="camera" size={18} color={T.terra} />
                    <Text style={s.uploadTxt}>{t("m.kyc.uploadPhoto", { defaultValue: "Upload a photo" })}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>

        <Text style={s.note}>🔒 {t("m.kyc.note", { defaultValue: "Your documents are encrypted and used only for verification. Max 5 MB · JPG, PNG, or PDF." })}</Text>
      </ScrollView>
    </Background>
  );
}

const s = StyleSheet.create({
  statusCard: { flexDirection: "row", gap: 14, padding: 16, borderRadius: 18, marginTop: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  statusIco: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  statusTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  statusSub: { fontSize: 13, color: T.muted, marginTop: 4, lineHeight: 19, fontFamily: font.body },
  sec: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginTop: 24, marginBottom: 12 },
  docCard: { padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", backgroundColor: "rgba(255,255,255,0.85)" },
  docHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  docIco: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: T.greenSoft },
  docLabel: { fontSize: 14.5, fontFamily: font.bodyBold, color: T.ink },
  docDesc: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: font.body },
  reqBadge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: "rgba(164,93,98,0.14)" },
  reqTxt: { fontSize: 10, fontFamily: font.bodyHeavy, color: T.coral },
  doneChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.12)" },
  doneTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: "#2f7d55" },
  uploadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginTop: 12, minHeight: 48, borderRadius: 14, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  uploadTxt: { color: T.terra, fontFamily: font.bodyHeavy, fontSize: 14 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
  preview: { width: 54, height: 54, borderRadius: 12, backgroundColor: T.line },
  previewTitle: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  previewSub: { fontSize: 12, color: T.muted, marginTop: 2, fontFamily: font.body },
  replaceBtn: { minHeight: 38, paddingHorizontal: 14, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  replaceTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },
  note: { fontSize: 12, color: T.muted, marginTop: 20, lineHeight: 18, fontFamily: font.body },
});
