// design/screens/ThreadScreen.tsx — message thread, wired to /api/chat.
// Signed in → real messages with the other party (route param `id` = their
// user id); send hits POST /api/chat/messages. Signed out → mock demo thread.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, Linking } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../Icon";
import { Ph, IconBtn } from "../primitives";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { fetchMessages, sendMessage, markConversationRead } from "../api/chat";
import { fetchCallRelationship } from "../api/bookings";
import { track } from "../api/analyticsEvents";
import { T, font, noOutline } from "../theme";

type Line = { id?: string; me: boolean; t: string };

export function ThreadScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { t } = useLanguage();

  const otherUserId: string = route.params?.id;
  const mock = { name: t("m.thread.conversation", { defaultValue: "Conversation" }), role: "", last: "", tone: "aubergine" as const, icon: "message" };
  const headerName: string = route.params?.name ?? t("m.thread.conversation", { defaultValue: "Conversation" });
  const real = !!user;

  const q = useQuery({
    queryKey: ["messages", otherUserId],
    queryFn: () => fetchMessages(otherUserId),
    enabled: real && !!otherUserId,
    staleTime: 10_000,
    retry: 1,
  });

  // Lines derived from the server (oldest→newest), plus any optimistic sends.
  const serverLines: Line[] = useMemo(
    () =>
      (q.data ?? [])
        .slice()
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((m) => ({ id: m.id, me: m.senderId === user?.id, t: m.content })),
    [q.data, user?.id],
  );

  const [pending, setPending] = useState<Line[]>([]);
  const [mockMsgs, setMockMsgs] = useState<Line[]>([]);
  const [val, setVal] = useState("");
  const feedRef = useRef<ScrollView>(null);

  const lines = real ? [...serverLines, ...pending] : mockMsgs;
  useEffect(() => { feedRef.current?.scrollToEnd({ animated: true }); }, [lines.length]);

  // Clear the unread badge once the thread is open (best-effort).
  useEffect(() => {
    if (real && otherUserId) {
      markConversationRead(otherUserId).then(() => qc.invalidateQueries({ queryKey: ["conversations"] })).catch(() => {});
    }
  }, [real, otherUserId]);

  // Drop optimistic rows once the server confirms them (refetch merged them in).
  useEffect(() => { if (q.data) setPending([]); }, [q.data]);

  // Call gate: is there an active booking linking me and this peer? Drives the
  // in-chat Call button (shown only once a real booking exists) and the roles
  // subtitle ("Host · Driver"). Pre-booking discovery chats hide the button.
  const rel = useQuery({
    queryKey: ["call-relationship", otherUserId],
    queryFn: () => fetchCallRelationship(otherUserId),
    enabled: real && !!otherUserId,
    staleTime: 30_000,
  });
  const canCall = !!(rel.data?.hasActiveBooking && rel.data?.phone);
  const roleLabels: Record<string, string> = {
    host: t("m.thread.roleHost", { defaultValue: "Host" }),
    provider: t("m.thread.roleProvider", { defaultValue: "Provider" }),
    driver: t("m.thread.roleDriver", { defaultValue: "Driver" }),
    guest: t("m.thread.roleGuest", { defaultValue: "Guest" }),
  };
  const rolesSubtitle = (rel.data?.roles ?? [])
    .map((r) => roleLabels[r])
    .filter(Boolean)
    .join(" · ");

  const onCall = () => {
    const phone = rel.data?.phone;
    if (!phone) return;
    void track("provider_call_clicked", { source: "thread", props: { roles: rel.data?.roles ?? [] } });
    Linking.openURL(`tel:${phone}`).catch(() => {});
  };

  const send = async () => {
    const text = val.trim();
    if (!text) return;
    setVal("");
    if (!real) {
      setMockMsgs((p) => [...p, { me: true, t: text }]);
      return;
    }
    setPending((p) => [...p, { me: true, t: text }]);
    try {
      await sendMessage(otherUserId, text);
      await q.refetch();
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch {
      setPending((p) => p.filter((x) => x.t !== text)); // roll back on failure
      setVal(text);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f4eff0" }}>
      <View style={[s.head, { paddingTop: insets.top + 6 }]}>
        <IconBtn name="chevL" onPress={() => nav.goBack()} bare />
        <View style={s.avatar}><Ph tone={mock.tone} icon="message" style={StyleSheet.absoluteFill as any} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.name}>{headerName}</Text>
          <Text style={s.role}>{real ? (rolesSubtitle || t("m.thread.tapToChat", { defaultValue: "Tap to chat" })) : `${mock.role} ${t("m.thread.online", { defaultValue: "· online" })}`}</Text>
        </View>
        {canCall && (
          <Pressable style={s.callBtn} onPress={onCall} accessibilityLabel={t("m.thread.call", { defaultValue: "Call" })}>
            <Icon name="phone" size={20} color={T.aubergine} />
          </Pressable>
        )}
      </View>

      <ScrollView ref={feedRef} contentContainerStyle={{ padding: 18, gap: 12 }} showsVerticalScrollIndicator={false}>
        <Text style={s.today}>{t("m.thread.today", { defaultValue: "Today" })}</Text>
        {lines.map((x, i) => (
          <View key={x.id ?? `p${i}`} style={[s.bubble, x.me ? s.me : s.them]}>
            <Text style={[s.bubbleTxt, x.me && { color: "#fff" }]}>{x.t}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.field}>
          <TextInput value={val} onChangeText={setVal} placeholder={t("m.thread.messagePlaceholder", { defaultValue: "Message…" })} placeholderTextColor={T.muted} style={s.input} onSubmitEditing={send} returnKeyType="send" />
        </View>
        <Pressable style={s.send} onPress={send}><Icon name="send" size={20} color="#fff" /></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "rgba(23,22,28,0.08)", backgroundColor: "rgba(255,255,255,0.6)" },
  avatar: { width: 42, height: 42, borderRadius: 14, overflow: "hidden" },
  name: { fontSize: 15.5, fontFamily: font.head, color: T.ink },
  role: { fontSize: 12, color: T.muted, fontFamily: font.body },
  callBtn: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  today: { textAlign: "center", color: T.muted, fontSize: 12, fontFamily: font.body, paddingVertical: 4 },
  bubble: { maxWidth: "80%", paddingVertical: 13, paddingHorizontal: 15, borderRadius: 20 },
  them: { alignSelf: "flex-start", backgroundColor: "rgba(255,255,255,0.95)", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", borderTopLeftRadius: 6 },
  me: { alignSelf: "flex-end", backgroundColor: T.aubergine, borderTopRightRadius: 6 },
  bubbleTxt: { fontSize: 14, lineHeight: 20, color: T.ink, fontFamily: font.body },
  composer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  field: { flex: 1, minHeight: 48, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.85)", justifyContent: "center" },
  input: { fontFamily: font.body, fontSize: 15, color: T.ink, paddingVertical: 0, ...noOutline },
  send: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
});
