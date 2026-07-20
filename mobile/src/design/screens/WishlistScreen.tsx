// design/screens/WishlistScreen.tsx — saved stays/services/transport (Phase 1 functional).
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Background } from "../Background";
import { Segmented, SectionHead } from "../primitives";
import { Icon } from "../Icon";
import { StayCard, ServiceCard, TransportCard } from "./cards";
import { useDesign } from "../DesignContext";
import { useWishlistListings } from "../api/hooks";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font } from "../theme";

export function WishlistScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { wish } = useDesign();
  // Saved cards resolved per-ID (not filtered from the limit-60 catalog feed,
  // which silently dropped any save that fell off the newest-60 page).
  const saved = useWishlistListings();
  const { t } = useLanguage();
  const [seg, setSeg] = useState("stays");

  // Tab screens stay mounted — refresh the saved-id buckets whenever the tab
  // is focused so hearts toggled elsewhere (detail pages, Explore) show up.
  const focused = useIsFocused();
  useEffect(() => { if (focused) void saved.refetch(); }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const SEGS: [string, string, string][] = [
    ["stays", "bedDouble", t("m.wishlist.segStays", { defaultValue: "Stays" })],
    ["services", "sparkle", t("m.wishlist.segServices", { defaultValue: "Services" })],
    ["transport", "car", t("m.wishlist.segTransport", { defaultValue: "Transport" })],
  ];

  // Intersect with the live heart Set so an unsave disappears instantly
  // instead of waiting for the buckets refetch.
  const stays = saved.stays.filter((s) => wish.has(s.id));
  const svcs = saved.services.filter((s) => wish.has(s.id));
  const trans = saved.transport.filter((t) => wish.has(t.id));
  const list = seg === "stays" ? stays : seg === "services" ? svcs : trans;

  return (
    <Background>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 6, paddingBottom: 122 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionHead title={t("m.wishlist.title", { defaultValue: "Your wishlist" })} />
        <Segmented options={SEGS} value={seg} onChange={setSeg} />
        <View style={{ gap: 16, marginTop: 16 }}>
          {seg === "stays" && stays.map((s) => <StayCard key={s.id} stay={s} onOpen={() => nav.navigate("StayDetail", { id: s.id })} />)}
          {seg === "services" && svcs.map((s) => <ServiceCard key={s.id} service={s} vertical onOpen={() => nav.navigate("ServiceDetail", { id: s.id })} />)}
          {seg === "transport" && trans.map((t) => <TransportCard key={t.id} item={t} vertical onOpen={() => nav.navigate("TransportDetail", { id: t.id })} />)}
          {list.length === 0 && !saved.loading && (
            <View style={styles.empty}>
              <Icon name="heart" size={30} color={T.muted} />
              <Text style={styles.emptyTxt}>{t("m.wishlist.empty", { defaultValue: "Nothing saved here yet. Tap the heart on any listing." })}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", gap: 10, paddingVertical: 60, paddingHorizontal: 30 },
  emptyTxt: { color: T.muted, fontFamily: font.body, textAlign: "center" },
});
