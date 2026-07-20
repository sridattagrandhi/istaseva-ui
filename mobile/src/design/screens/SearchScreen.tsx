// design/screens/SearchScreen.tsx — search over the REAL catalog (useCatalog),
// across stays, services and transport. Falls back to bundled mock per-segment
// when the backend has no rows (the catalog dev-bridge).
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Background } from "../Background";
import { Icon } from "../Icon";
import { IconBtn, SearchBar, Ph, rupee } from "../primitives";
import { useCatalog } from "../api/hooks";
import { useLanguage } from "@/contexts/LanguageContext";
import { T, font } from "../theme";

const norm = (v: any) => String(v == null ? "" : v).toLowerCase();

export function SearchScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [q, setQ] = React.useState("");
  const C = useCatalog();

  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const hit = (...vals: any[]) => vals.some((v) => norm(v).includes(query));

  const stayHits = searching ? C.stays.filter((s) => hit(s.title, s.type, s.location, s.district, s.owner, s.address)) : [];
  const svcHits = searching ? C.services.filter((s) => hit(s.title, s.provider, s.category, s.subcategory, s.location, s.blurb)) : [];
  const trHits = searching ? C.transport.filter((t) => hit(t.driver, t.vehicle, t.type, t.area, (t.languages || []).join(" "))) : [];
  const resultCount = stayHits.length + svcHits.length + trHits.length;

  const trending = C.stays.slice(0, 3);

  const Row = ({ tone, icon, title, sub, onPress }: any) => (
    <Pressable style={styles.trend} onPress={onPress}>
      <View style={styles.thumb}><Ph tone={tone} icon={icon} style={StyleSheet.absoluteFill as any} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.trendTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.trendSub} numberOfLines={1}>{sub}</Text>
      </View>
      <Icon name="arrowR" size={18} color={T.muted} />
    </Pressable>
  );

  return (
    <Background>
      <View style={[styles.appbar, { paddingTop: insets.top + 4 }]}>
        <IconBtn name="chevL" onPress={() => nav.goBack()} />
        <View style={{ flex: 1 }}>
          <SearchBar value={q} onChange={setQ} onClear={() => setQ("")} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {searching ? (
          resultCount === 0 ? (
            <View style={styles.empty}>
              <Icon name="search" size={26} color={T.muted} />
              <Text style={styles.emptyTxt}>{t("m.search.noMatches", { defaultValue: "No matches for “{{query}}”", query: q })}</Text>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              <Text style={styles.secTitle}>{resultCount === 1 ? t("m.search.resultCountOne", { defaultValue: "{{count}} result", count: resultCount }) : t("m.search.resultCountOther", { defaultValue: "{{count}} results", count: resultCount })}</Text>
              {stayHits.map((s) => (
                <Row key={"s" + s.id} tone={s.tone} icon="bedDouble" title={s.title} sub={`${s.location} · ${rupee(s.price)}${t("m.search.perNight", { defaultValue: "/night" })}`} onPress={() => nav.navigate("StayDetail", { id: s.id })} />
              ))}
              {svcHits.map((s) => (
                <Row key={"v" + s.id} tone={s.tone} icon={s.icon || "sparkle"} title={s.title} sub={`${s.provider} · ${rupee(s.price)}`} onPress={() => nav.navigate("ServiceDetail", { id: s.id })} />
              ))}
              {trHits.map((t) => (
                <Row key={"t" + t.id} tone={t.tone} icon="car" title={`${t.driver} · ${t.vehicle}`} sub={`${t.type} · ${t.area}`} onPress={() => nav.navigate("TransportDetail", { id: t.id })} />
              ))}
            </View>
          )
        ) : (
          <>
            {trending.length > 0 && <Text style={styles.secTitle}>{t("m.search.trendingNearby", { defaultValue: "Trending nearby" })}</Text>}
            <View style={{ gap: 12 }}>
              {trending.map((s) => (
                <Row key={s.id} tone={s.tone} icon="bedDouble" title={s.title} sub={`${s.location} · ${rupee(s.price)}${t("m.search.perNight", { defaultValue: "/night" })}`} onPress={() => nav.navigate("StayDetail", { id: s.id })} />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12 },
  secTitle: { fontFamily: font.head, fontSize: 16, color: T.ink, marginBottom: 12 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.85)", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)" },
  pillTxt: { fontFamily: font.bodyBold, fontSize: 13, color: T.aubergine },
  trend: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.9)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  thumb: { width: 52, height: 52, borderRadius: 12, overflow: "hidden" },
  trendTitle: { fontFamily: font.bodyBold, fontSize: 14, color: T.ink },
  trendSub: { fontFamily: font.body, fontSize: 12, color: T.muted, marginTop: 2 },
  empty: { alignItems: "center", gap: 10, paddingVertical: 48 },
  emptyTxt: { fontFamily: font.bodyBold, fontSize: 14, color: T.ink },
});
