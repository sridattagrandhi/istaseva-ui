// design/screens/ProfileEditScreen.tsx — edit the marketplace profile
// (display name, photo, phone, location, bio, language) via /api/users/me/profile.
import React, { useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, Image, ActivityIndicator, Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Background } from "../Background";
import { Icon } from "../Icon";
import { AppBar, PrimaryButton } from "../primitives";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchMyProfile, updateMyProfile, UserProfile } from "../api/users";
import { uploadToStorage } from "../api/storage";
import { T, font, noOutline } from "../theme";

const FIELDS: { key: keyof UserProfile; labelKey: string; labelDefault: string; placeholderKey: string; placeholderDefault: string; multiline?: boolean; keyboardType?: any }[] = [
  { key: "displayName", labelKey: "m.profileEdit.displayNameLabel", labelDefault: "Display name", placeholderKey: "m.profileEdit.displayNamePlaceholder", placeholderDefault: "How hosts & guests see you" },
  { key: "phone", labelKey: "m.profileEdit.phoneLabel", labelDefault: "Phone", placeholderKey: "m.profileEdit.phonePlaceholder", placeholderDefault: "+91 9XXXXXXXXX", keyboardType: "phone-pad" },
  { key: "location", labelKey: "m.profileEdit.locationLabel", labelDefault: "Location", placeholderKey: "m.profileEdit.locationPlaceholder", placeholderDefault: "City, State" },
  { key: "preferredLanguage", labelKey: "m.profileEdit.preferredLanguageLabel", labelDefault: "Preferred language", placeholderKey: "m.profileEdit.preferredLanguagePlaceholder", placeholderDefault: "e.g. Telugu, English" },
  { key: "bio", labelKey: "m.profileEdit.bioLabel", labelDefault: "About you", placeholderKey: "m.profileEdit.bioPlaceholder", placeholderDefault: "A line or two about yourself", multiline: true },
];

export function ProfileEditScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { t } = useLanguage();

  const q = useQuery({ queryKey: ["profile"], queryFn: fetchMyProfile, enabled: !!user, staleTime: 30_000, retry: 1 });
  const [form, setForm] = useState<Partial<UserProfile>>({});
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Seed the form once the profile loads.
  React.useEffect(() => {
    if (q.data && !seeded) { setForm(q.data); setSeeded(true); }
  }, [q.data, seeded]);

  const set = (k: keyof UserProfile, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const pickAvatar = async () => {
    if (!user) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, allowsEditing: true, aspect: [1, 1] });
    if (res.canceled) return;
    setUploading(true);
    try {
      const url = await uploadToStorage({ userId: user.id, uri: res.assets[0].uri, bucket: "uploads", keyPrefix: "avatars" });
      set("avatarUrl", url);
    } catch (e: any) {
      Alert.alert(t("m.profileEdit.uploadFailedTitle", { defaultValue: "Upload failed" }), e?.message || t("m.profileEdit.uploadFailedMsg", { defaultValue: "Could not upload photo." }));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateMyProfile(form);
      qc.invalidateQueries({ queryKey: ["profile"] });
      nav.goBack();
    } catch (e: any) {
      Alert.alert(t("m.profileEdit.saveFailedTitle", { defaultValue: "Couldn't save" }), e?.response?.data?.error?.message || e?.message || t("m.profileEdit.saveFailedMsg", { defaultValue: "Please try again." }));
    } finally {
      setSaving(false);
    }
  };

  const initials = (form.displayName || user?.name || "U").split(/[\s.@]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <Background>
      <View style={{ paddingTop: insets.top + 6 }}>
        <AppBar title={t("m.profileEdit.title", { defaultValue: "Edit profile" })} sub={t("m.profileEdit.subtitle", { defaultValue: "Your public marketplace profile" })} onBack={() => nav.goBack()} />
      </View>
      {q.isLoading ? (
        <ActivityIndicator color={T.aubergine} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={st.avatarWrap}>
            <Pressable style={st.avatar} onPress={pickAvatar}>
              {form.avatarUrl ? (
                <Image source={{ uri: form.avatarUrl }} style={StyleSheet.absoluteFill as any} />
              ) : (
                <Text style={st.avatarTxt}>{initials}</Text>
              )}
              <View style={st.camBadge}>
                {uploading ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="camera" size={15} color="#fff" />}
              </View>
            </Pressable>
            <Text style={st.avatarHint}>{t("m.profileEdit.tapToChangePhoto", { defaultValue: "Tap to change photo" })}</Text>
            {form.avatarUrl ? (
              <Pressable
                onPress={() => setForm((p) => ({ ...p, avatarUrl: null as any }))}
                disabled={uploading}
                hitSlop={8}
              >
                <Text style={st.removePhoto}>{t("m.profileEdit.removePhoto", { defaultValue: "Remove photo" })}</Text>
              </Pressable>
            ) : null}
          </View>

          {FIELDS.map((f) => (
            <View key={f.key} style={st.field}>
              <Text style={st.label}>{t(f.labelKey, { defaultValue: f.labelDefault })}</Text>
              <TextInput
                value={(form[f.key] as string) || ""}
                onChangeText={(v) => set(f.key, v)}
                placeholder={t(f.placeholderKey, { defaultValue: f.placeholderDefault })}
                placeholderTextColor={T.muted}
                keyboardType={f.keyboardType}
                multiline={f.multiline}
                style={[st.input, f.multiline && { height: 92, textAlignVertical: "top", paddingTop: 12 }]}
              />
            </View>
          ))}

          <View style={{ marginTop: 12 }}>
            <PrimaryButton label={saving ? t("m.profileEdit.saving", { defaultValue: "Saving…" }) : t("m.profileEdit.saveChanges", { defaultValue: "Save changes" })} onPress={saving ? undefined : save} />
          </View>
        </ScrollView>
      )}
    </Background>
  );
}

const st = StyleSheet.create({
  avatarWrap: { alignItems: "center", marginTop: 8, marginBottom: 18 },
  avatar: { width: 92, height: 92, borderRadius: 999, backgroundColor: T.aubergine, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarTxt: { color: "#fff", fontFamily: font.headHeavy, fontSize: 30 },
  camBadge: { position: "absolute", right: 0, bottom: 0, width: 30, height: 30, borderRadius: 999, backgroundColor: T.terra, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#f4efe9" },
  avatarHint: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginTop: 8 },
  removePhoto: { fontFamily: font.bodySemi, fontSize: 12.5, color: T.coral, marginTop: 6 },
  field: { marginBottom: 14 },
  label: { fontFamily: font.bodyBold, fontSize: 13, color: T.ink, marginBottom: 6 },
  input: { minHeight: 48, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.85)", fontFamily: font.body, fontSize: 15, color: T.ink, ...noOutline },
});
