// design/screens/detailParts.tsx — shared listing-detail pieces ported from gallery.jsx + detail.jsx.
import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Dimensions, Modal, ScrollView, Image, ActivityIndicator, Share, Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { MapCanvas } from "./MapCanvas";
import { Icon } from "../Icon";
import { useLanguage } from "@/contexts/LanguageContext";
import { Ph, LIKE_RED } from "../primitives";
import { config } from "../../lib/config";
import { T, font, Tone, rupee } from "../theme";
import { Review } from "../types";

const TONE_CYCLE: Tone[] = ["saffron", "blue", "aubergine", "coral"];
const W = Dimensions.get("window").width;

/* ---------- Hero gallery ---------- */
export function HeroGallery({
  count = 1,
  icon,
  label,
  title,
  onBack,
  wishOn,
  onWish,
  insetTop,
  photoUrls,
  shareText,
  shareKind,
  shareId,
}: {
  count?: number;
  icon: string;
  label?: string;
  title?: string;
  onBack: () => void;
  wishOn?: boolean;
  onWish?: () => void;
  insetTop: number;
  photoUrls?: string[];
  shareText?: string;
  shareKind?: "stay" | "service" | "transport";
  shareId?: string;
}) {
  const { t } = useLanguage();
  const urls = photoUrls && photoUrls.length ? photoUrls : null;
  const total = urls ? urls.length : count;
  const [pic, setPic] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const go = (d: number) => setPic((p) => (p + d + total) % total);
  const caption = `${label || t("m.detailParts.photo", { defaultValue: "Photo" })} ${pic + 1}`;

  // Web listing URL (config.webUrl mirrors web's origin) so a shared link
  // opens the same page. Falls back to a link-less text share.
  const shareUrl = shareKind && shareId ? `${config.webUrl}/${shareKind}/${encodeURIComponent(shareId)}` : "";
  const shareMsg = () => {
    const head = shareText || [title, label].filter(Boolean).join(" · ");
    const foot = t("m.detailParts.foundOn", { defaultValue: "Found on IstaSeva 🙏" });
    return `${head}${shareUrl ? `\n${shareUrl}` : ""}\n\n${foot}`;
  };
  const onWhatsApp = async () => {
    setShareOpen(false);
    try { await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(shareMsg())}`); } catch { /* no handler */ }
  };
  // Copy link via the native sheet's "Copy" (no expo-clipboard — that native
  // module isn't in the dev build; see dash/BookForGuest.tsx). Shares just the
  // URL so "Copy" lands a clean link.
  const onCopyLink = async () => {
    setShareOpen(false);
    try { await Share.share({ message: shareUrl || shareMsg() }); } catch { /* dismissed */ }
  };
  const onMore = async () => {
    setShareOpen(false);
    try { await Share.share({ message: shareMsg(), title: title || "IstaSeva" }); } catch { /* dismissed */ }
  };

  return (
    <View style={styles.hero}>
      {urls ? (
        <Image source={{ uri: urls[pic % urls.length] }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
      ) : (
        <Ph tone={TONE_CYCLE[pic % TONE_CYCLE.length]} icon={icon} label={caption} style={StyleSheet.absoluteFill as any} />
      )}
      <View style={[styles.heroBar, { top: insetTop + 4 }]}>
        <Pressable style={({ pressed }) => [styles.heroBtn, pressed && styles.heroBtnPressed]} onPress={onBack}>
          <Icon name="chevL" size={22} color={T.ink} />
        </Pressable>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable style={({ pressed }) => [styles.heroBtn, pressed && styles.heroBtnPressed]} onPress={() => setShareOpen(true)} hitSlop={6}>
            <Icon name="share" size={18} color={T.ink} />
          </Pressable>
          {onWish && (
            <Pressable style={({ pressed }) => [styles.heroBtn, pressed && styles.heroBtnPressed]} onPress={onWish} hitSlop={6}>
              <Icon name={wishOn ? "heartFill" : "heart"} size={20} color={wishOn ? LIKE_RED : T.aubergine} strokeWidth={2} />
            </Pressable>
          )}
        </View>
      </View>
      {total > 1 && (
        <>
          <Pressable style={({ pressed }) => [styles.galleryNav, { left: 12 }, pressed && styles.heroBtnPressed]} onPress={() => go(-1)}>
            <Icon name="chevL" size={22} color={T.ink} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.galleryNav, { right: 12 }, pressed && styles.heroBtnPressed]} onPress={() => go(1)}>
            <Icon name="chevR" size={22} color={T.ink} />
          </Pressable>
          <View style={styles.dots}>
            {Array.from({ length: Math.min(total, 6) }).map((_, i) => (
              <View key={i} style={[styles.dot, i === pic % 6 && styles.dotOn]} />
            ))}
          </View>
        </>
      )}
      <Pressable style={({ pressed }) => [styles.photoCount, pressed && { transform: [{ scale: 0.96 }], opacity: 0.9 }]} onPress={() => setGalleryOpen(true)}>
        <Icon name="compass" size={13} color={T.ink} />
        <Text style={styles.photoCountTxt}>{t("m.detailParts.seeAllPhotos", { defaultValue: "See all {{count}} photos", count: total })}</Text>
      </Pressable>

      <PhotoGalleryModal visible={galleryOpen} onClose={() => setGalleryOpen(false)} urls={urls} count={count} icon={icon} label={label} title={title} />

      {/* Share sheet — WhatsApp is the dominant target in-market, so it gets a
          first-class row with the real brand mark; Copy link + More cover the
          rest without a clipboard native module. */}
      <Modal visible={shareOpen} transparent animationType="fade" onRequestClose={() => setShareOpen(false)}>
        <Pressable style={styles.shareBackdrop} onPress={() => setShareOpen(false)}>
          <Pressable style={styles.shareSheet} onPress={() => {}}>
            <View style={styles.shareGrab} />
            <Text style={styles.shareTitle}>{t("m.detailParts.shareTitle", { defaultValue: "Share this listing" })}</Text>
            <View style={styles.shareRow}>
              <Pressable style={({ pressed }) => [styles.shareOpt, pressed && { opacity: 0.7 }]} onPress={onWhatsApp}>
                <View style={[styles.shareIcon, { backgroundColor: "rgba(37,211,102,0.14)" }]}><Icon name="whatsapp" size={26} color="#25D366" /></View>
                <Text style={styles.shareOptTxt}>{t("m.detailParts.whatsapp", { defaultValue: "WhatsApp" })}</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.shareOpt, pressed && { opacity: 0.7 }]} onPress={onCopyLink}>
                <View style={[styles.shareIcon, { backgroundColor: "rgba(58,50,71,0.08)" }]}><Icon name="link" size={24} color={T.ink} /></View>
                <Text style={styles.shareOptTxt}>{t("m.detailParts.copyLink", { defaultValue: "Copy link" })}</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.shareOpt, pressed && { opacity: 0.7 }]} onPress={onMore}>
                <View style={[styles.shareIcon, { backgroundColor: "rgba(58,50,71,0.08)" }]}><Icon name="share" size={22} color={T.ink} /></View>
                <Text style={styles.shareOptTxt}>{t("m.detailParts.more", { defaultValue: "More" })}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/* ---------- Full-screen photo gallery ---------- */
function PhotoGalleryModal({ visible, onClose, urls, count, icon, label, title }: {
  visible: boolean; onClose: () => void; urls: string[] | null; count: number; icon: string; label?: string; title?: string;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const items: (string | null)[] = urls && urls.length ? urls : Array.from({ length: Math.max(1, count) }).map(() => null);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.galleryModal}>
        <View style={[styles.galleryHead, { paddingTop: insets.top + 6 }]}>
          <Pressable style={({ pressed }) => [styles.heroBtn, pressed && styles.heroBtnPressed]} onPress={onClose} hitSlop={6}>
            <Icon name="x" size={20} color={T.ink} />
          </Pressable>
          <Text style={styles.galleryTitle} numberOfLines={1}>{title || t("m.detailParts.photos", { defaultValue: "Photos" })}</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: insets.bottom + 28 }} showsVerticalScrollIndicator={false}>
          {items.map((u, i) => (
            <View key={i} style={styles.galleryPhotoWrap}>
              {u ? (
                <Image source={{ uri: u }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
              ) : (
                <Ph tone={TONE_CYCLE[i % TONE_CYCLE.length]} icon={icon} label={`${label || t("m.detailParts.photo", { defaultValue: "Photo" })} ${i + 1}`} style={StyleSheet.absoluteFill as any} />
              )}
              <View style={styles.galleryIndex}><Text style={styles.galleryIndexTxt}>{i + 1} / {items.length}</Text></View>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

/* ---------- Detail sheet wrapper (overlaps hero) ---------- */
export function DetailSheet({ children }: { children: React.ReactNode }) {
  return <View style={styles.sheet}>{children}</View>;
}

export function Eyebrow({ icon, children }: { icon?: string; children: React.ReactNode }) {
  return (
    <View style={styles.eyebrowRow}>
      {icon ? <Icon name={icon} size={12} color={T.aubergine} /> : null}
      <Text style={styles.eyebrow}>{children}</Text>
    </View>
  );
}

/** Full-screen loading state for a detail screen (real listing being fetched). */
export function DetailLoading({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={dpStatus.wrap}>
      <Pressable style={[dpStatus.back, { top: insets.top + 8 }]} onPress={onBack} hitSlop={8}><Icon name="chevL" size={22} color={T.ink} /></Pressable>
      <ActivityIndicator color={T.aubergine} />
    </View>
  );
}

/** Full-screen not-found state (real id returned nothing — deleted/unavailable). */
export function DetailNotFound({ onBack, label = "listing" }: { onBack: () => void; label?: string }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  return (
    <View style={dpStatus.wrap}>
      <Pressable style={[dpStatus.back, { top: insets.top + 8 }]} onPress={onBack} hitSlop={8}><Icon name="chevL" size={22} color={T.ink} /></Pressable>
      <Icon name="search" size={30} color={T.muted} />
      <Text style={dpStatus.txt}>{t("m.detailParts.notAvailable", { defaultValue: "This {{label}} isn’t available anymore.", label })}</Text>
      <Pressable style={dpStatus.btn} onPress={onBack}><Text style={dpStatus.btnTxt}>{t("m.detailParts.goBack", { defaultValue: "Go back" })}</Text></Pressable>
    </View>
  );
}

const dpStatus = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#f4efe9", alignItems: "center", justifyContent: "center", gap: 14, padding: 30 },
  back: { position: "absolute", left: 14, width: 42, height: 42, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.9)" },
  txt: { fontFamily: font.body, fontSize: 14.5, color: T.muted, textAlign: "center" },
  btn: { marginTop: 6, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 14, backgroundColor: T.aubergine },
  btnTxt: { fontFamily: font.bodyHeavy, fontSize: 14, color: "#fff" },
});

export const dt = StyleSheet.create({
  h1: { fontSize: 24, lineHeight: 27, fontFamily: font.head, color: T.ink, marginTop: 4 },
  h2: { fontSize: 19, fontFamily: font.head, color: T.ink },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  ratingStrong: { flexDirection: "row", alignItems: "center", gap: 4 },
  ratingTxt: { color: T.ink, fontFamily: font.bodyBold, fontSize: 13 },
  mutedSm: { color: T.muted, fontSize: 13, fontFamily: font.body },
  loc: { flexDirection: "row", gap: 6, marginTop: 8, alignItems: "flex-start" },
  locTxt: { color: T.muted, fontSize: 13, lineHeight: 19, fontFamily: font.body, flex: 1 },
  divider: { height: 1, backgroundColor: T.line, marginVertical: 18 },
  sectionTitle: { fontSize: 16, fontFamily: font.headHeavy, color: T.ink, marginBottom: 12, marginTop: 24 },
  body: { color: T.muted, fontSize: 14, lineHeight: 22, fontFamily: font.body },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});

export function StatBox({ icon, label, value, small }: { icon: string; label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <View style={styles.statBox}>
      <View style={styles.sbTop}>
        <Icon name={icon} size={15} color={T.muted} />
        <Text style={styles.sbLabel}>{label}</Text>
      </View>
      <Text style={[styles.sbValue, small && { fontSize: 18 }]}>{value}</Text>
    </View>
  );
}

export function LangChip({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.langChip}>
      <Icon name="languages" size={14} color={T.terra} />
      <Text style={styles.langChipTxt}>{children}</Text>
    </View>
  );
}

export function Pill({ active, icon, onPress, children }: { active?: boolean; icon?: string; onPress?: () => void; children: React.ReactNode }) {
  return (
    <Pressable style={[styles.pill, active && styles.pillActive]} onPress={onPress}>
      {icon ? <Icon name={icon} size={14} color={active ? "#fff" : T.aubergine} /> : null}
      <Text style={[styles.pillTxt, active && { color: "#fff" }]}>{children}</Text>
    </Pressable>
  );
}

export function VerifyChip({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.verifyChip}>
      <Icon name="badge" size={13} color="#2f7d55" />
      <Text style={styles.verifyTxt}>{children}</Text>
    </View>
  );
}

/** Driver opted into flexible hours at onboarding — informational tag telling
 *  riders they can message to arrange times outside the listed working hours.
 *  Mirrors the web's "Flexible hours" badge on the transport detail page. */
export function FlexibleChip() {
  const { t } = useLanguage();
  return (
    <View style={styles.flexChip}>
      <Icon name="clock" size={13} color={T.aubergine} />
      <Text style={styles.flexTxt}>{t("m.detailParts.flexibleHours", { defaultValue: "Flexible hours" })}</Text>
    </View>
  );
}

export function MiniMap({ lat, lng, label }: { lat?: number; lng?: number; label?: string } = {}) {
  const hasCoords = typeof lat === "number" && typeof lng === "number" && (lat !== 0 || lng !== 0);
  // Static map preview when the listing has coordinates (Apple Maps on iOS,
  // MapLibre on Android via MapCanvas). Falls back to the decorative
  // placeholder when coords are missing.
  if (hasCoords) {
    return (
      <View style={styles.miniMap}>
        <MapCanvas
          style={StyleSheet.absoluteFill as any}
          interactive={false}
          initialRegion={{ latitude: lat as number, longitude: lng as number, latitudeDelta: 0.018, longitudeDelta: 0.018 }}
          markers={[{ id: "loc", coordinate: { latitude: lat as number, longitude: lng as number } }]}
        />
      </View>
    );
  }
  return (
    <View style={styles.miniMap}>
      <View style={[styles.road, { left: "-10%", top: "46%", width: "125%", transform: [{ rotate: "-10deg" }] }]} />
      <View style={[styles.road, { left: "25%", top: "6%", width: "80%", transform: [{ rotate: "44deg" }] }]} />
      <View style={styles.locPin}>
        <Icon name="mappin" size={18} color="#fff" />
      </View>
    </View>
  );
}

/* ---------- Reviews ---------- */
function distribution(rating: number, n: number) {
  const d: [number, number][] = [[5, Math.round(n * 0.74)], [4, Math.round(n * 0.18)], [3, Math.round(n * 0.05)], [2, Math.round(n * 0.02)], [1, 0]];
  const sum = d.reduce((a, [, c]) => a + c, 0);
  d[0][1] = Math.max(0, d[0][1] + (n - sum));
  return d;
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function ReviewCard({ rv }: { rv: Review }) {
  return (
    <View style={styles.reviewCard}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={styles.rvAvatar}>
          <Text style={styles.rvAvatarTxt}>{initials(rv.name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rvName}>{rv.name}</Text>
          <Text style={styles.rvWhen}>{rv.when}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 1 }}>
          {Array.from({ length: rv.rating }).map((_, i) => <Icon key={i} name="starFill" size={12} color={T.saffron} />)}
        </View>
      </View>
      <Text style={styles.rvText}>“{rv.text}”</Text>
    </View>
  );
}

type TFn = (key: string, opts?: Record<string, any>) => string;

const fillerReviews = (t: TFn): Review[] => [
  { name: "Anand R.", when: t("m.detailParts.filler1When", { defaultValue: "Stayed in March" }), rating: 5, text: t("m.detailParts.filler1Text", { defaultValue: "Exactly as described. Smooth booking and very responsive." }) },
  { name: "Divya K.", when: t("m.detailParts.filler2When", { defaultValue: "Visited in February" }), rating: 4, text: t("m.detailParts.filler2Text", { defaultValue: "Good experience overall, would book again. Minor wait at the start." }) },
  { name: "Mohan B.", when: t("m.detailParts.filler3When", { defaultValue: "In January" }), rating: 5, text: t("m.detailParts.filler3Text", { defaultValue: "Professional and friendly. Highly recommended to families." }) },
];

function RatingBreakdown({ rating, reviews }: { rating: number; reviews: number }) {
  const { t } = useLanguage();
  const dist = distribution(rating, reviews);
  const max = Math.max(...dist.map(([, c]) => c), 1);
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={styles.bigRating}>{rating.toFixed(1)}</Text>
        <Text style={dt.mutedSm}>{t("m.detailParts.reviewsCount", { defaultValue: "{{count}} reviews", count: reviews })}</Text>
      </View>
      <View style={{ gap: 7, marginTop: 14 }}>
        {dist.map(([star, c]) => (
          <View key={star} style={styles.rbRow}>
            <View style={styles.rbStar}>
              <Text style={styles.rbStarTxt}>{star}</Text>
              <Icon name="starFill" size={11} color={T.saffron} />
            </View>
            <View style={styles.rbTrack}>
              <View style={[styles.rbFill, { width: `${(c / max) * 100}%` }]} />
            </View>
            <Text style={styles.rbN}>{c}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

function ReviewsModal({ rating, reviews, full, visible, onClose }: { rating: number; reviews: number; full: Review[]; visible: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const SORTS: [string, string][] = [
    ["recent", t("m.detailParts.sortRecent", { defaultValue: "Most recent" })],
    ["highest", t("m.detailParts.sortHighest", { defaultValue: "Highest" })],
    ["lowest", t("m.detailParts.sortLowest", { defaultValue: "Lowest" })],
  ];
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<number | "all">("all");
  const [sort, setSort] = useState("recent");
  const dist = distribution(rating, reviews);
  const shown = filter === "all" ? [...full] : full.filter((r) => r.rating === filter);
  if (sort === "highest") shown.sort((a, b) => b.rating - a.rating);
  else if (sort === "lowest") shown.sort((a, b) => a.rating - b.rating);
  const chips: [number | "all", string][] = [["all", t("m.detailParts.chipAll", { defaultValue: "All {{count}}", count: reviews })], ...([5, 4, 3, 2, 1].map((n) => [n, `${n}★ ${dist.find(([k]) => k === n)![1]}`]) as [number, string][])];
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#faf8fa", paddingTop: insets.top }}>
        <View style={styles.fsHead}>
          <Pressable onPress={onClose} style={({ pressed }: any) => [{ padding: 6 }, pressed && { opacity: 0.6 }]}><Icon name="x" size={24} color={T.ink} /></Pressable>
          <Text style={styles.fsTitle}>{t("m.detailParts.reviews", { defaultValue: "Reviews" })}</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 8 }}>
            <Text style={[styles.bigRating, { fontSize: 34 }]}>{rating.toFixed(1)}</Text>
            <Text style={dt.mutedSm}><Icon name="starFill" size={13} color={T.saffron} /> {t("m.detailParts.reviewsCount", { defaultValue: "{{count}} reviews", count: reviews })}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 14 }}>
            {chips.map(([k, lb]) => (
              <Pressable key={String(k)} onPress={() => setFilter(k)} style={({ pressed }: any) => [styles.fChip, filter === k && styles.fChipActive, pressed && { opacity: 0.8 }]}>
                <Text style={[styles.fChipTxt, filter === k && { color: "#fff" }]}>{lb}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Text style={dt.mutedSm}>{shown.length === 1 ? t("m.detailParts.reviewCountOne", { defaultValue: "{{count}} review", count: shown.length }) : t("m.detailParts.reviewCountOther", { defaultValue: "{{count}} reviews", count: shown.length })}</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {SORTS.map(([k, lb]) => (
                <Pressable key={k} onPress={() => setSort(k)} style={({ pressed }: any) => [styles.sortPill, sort === k && styles.sortPillActive, pressed && { opacity: 0.8 }]}>
                  <Text style={[styles.sortTxt, sort === k && { color: "#fff" }]}>{lb}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={{ gap: 12 }}>
            {shown.length ? shown.map((rv, i) => <ReviewCard key={i} rv={rv} />) : <Text style={[dt.mutedSm, { textAlign: "center", padding: 24 }]}>{t("m.detailParts.noStarReviews", { defaultValue: "No {{stars}}★ reviews yet.", stars: filter })}</Text>}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

export function ReviewsSection({ rating, reviews, list, emptyText }: { rating: number; reviews: number; list: Review[]; emptyText?: string }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!reviews) {
    return (
      <View style={styles.glass}>
        <Text style={styles.rvName}>{t("m.detailParts.noReviewsYet", { defaultValue: "No reviews yet" })}</Text>
        <Text style={[dt.body, { marginTop: 8 }]}>{emptyText || t("m.detailParts.beTheFirst", { defaultValue: "Be the first to share an experience." })}</Text>
      </View>
    );
  }
  const FILLER = fillerReviews(t);
  const full = [...(list || [])];
  let i = 0;
  while (full.length < Math.min(reviews, 8) && i < FILLER.length) full.push(FILLER[i++]);
  return (
    <>
      <RatingBreakdown rating={rating} reviews={reviews} />
      <View style={{ gap: 12, marginTop: 16 }}>
        {full.slice(0, 2).map((rv, idx) => <ReviewCard key={idx} rv={rv} />)}
      </View>
      <Pressable style={styles.ghostBtn} onPress={() => setOpen(true)}>
        <Text style={styles.ghostBtnTxt}>{t("m.detailParts.showAllReviews", { defaultValue: "Show all {{count}} reviews", count: reviews })}</Text>
      </Pressable>
      <ReviewsModal rating={rating} reviews={reviews} full={full} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ---------- CTA bar ---------- */
export function CtaBar({
  price,
  unit,
  rating,
  meta,
  label,
  onPress,
  insetBottom,
}: {
  price: string;
  unit?: string;
  rating: number;
  meta: string;
  label: string;
  onPress: () => void;
  insetBottom: number;
}) {
  return (
    <View style={[styles.ctaBar, { bottom: Math.max(insetBottom, 12) }]}>
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.ctaPrice}>{price}{unit ? <Text style={styles.ctaUnit}>{unit}</Text> : null}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="starFill" size={11} color={T.saffron} />
          <Text style={styles.ctaMeta}>{rating} · {meta}</Text>
        </View>
      </View>
      <Pressable style={({ pressed }) => [styles.ctaBtn, pressed && { transform: [{ scale: 0.98 }], opacity: 0.95 }]} onPress={onPress}>
        <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ctaBtnInner}>
          <Text style={styles.ctaBtnTxt}>{label}</Text>
        </LinearGradient>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 320, position: "relative" },
  heroBar: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", zIndex: 5 },
  heroBtn: {
    width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.9)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 4,
  },
  galleryNav: {
    position: "absolute", top: "46%", width: 38, height: 38, borderRadius: 999, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.9)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4,
  },
  dots: { position: "absolute", bottom: 18, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.55)" },
  dotOn: { backgroundColor: "#fff", width: 18 },
  photoCount: {
    position: "absolute", right: 16, bottom: 44, flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.92)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4,
  },
  photoCountTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.ink },
  heroBtnPressed: { transform: [{ scale: 0.9 }], backgroundColor: "#fff" },
  shareBackdrop: { flex: 1, backgroundColor: "rgba(23,22,28,0.45)", justifyContent: "flex-end" },
  shareSheet: { backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 34 },
  shareGrab: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: "rgba(23,22,28,0.16)", marginBottom: 16 },
  shareTitle: { fontSize: 15.5, fontFamily: font.bodyBold, color: T.ink, marginBottom: 16 },
  shareRow: { flexDirection: "row", gap: 14 },
  shareOpt: { alignItems: "center", gap: 8, width: 84 },
  shareIcon: { width: 60, height: 60, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  shareOptTxt: { fontSize: 12, fontFamily: font.bodySemi, color: T.ink },
  galleryModal: { flex: 1, backgroundColor: "#f4efe9" },
  galleryHead: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 10 },
  galleryTitle: { flex: 1, fontFamily: font.head, fontSize: 17, color: T.ink },
  galleryPhotoWrap: { width: "100%", aspectRatio: 4 / 3, borderRadius: 18, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.04)" },
  galleryIndex: { position: "absolute", left: 12, bottom: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: "rgba(23,20,29,0.55)" },
  galleryIndexTxt: { color: "#fff", fontSize: 11, fontFamily: font.bodyBold },

  sheet: {
    marginTop: -28,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: "rgba(250,248,250,0.99)",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.8)",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
  },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  eyebrow: { color: T.aubergine, fontSize: 12, fontFamily: font.bodyHeavy, letterSpacing: 1 },

  statBox: {
    // Soft tinted tile (no border/crisp fill) so it reads as a stat, not a
    // tappable button. Keeps the visual anchor without the chip affordance.
    minWidth: 104, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16,
    backgroundColor: "rgba(58,50,71,0.06)", gap: 4,
  },
  sbTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  sbLabel: { fontSize: 10.5, fontFamily: font.bodyHeavy, letterSpacing: 0.6, color: T.muted },
  sbValue: { fontSize: 26, fontFamily: font.head, color: T.ink, lineHeight: 28 },

  langChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  langChipTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },

  pill: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  pillActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  pillTxt: { color: T.aubergine, fontSize: 12.5, fontFamily: font.bodyBold },

  verifyChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.1)", borderWidth: 1, borderColor: "rgba(47,125,85,0.25)" },
  verifyTxt: { color: "#2f7d55", fontSize: 12, fontFamily: font.bodyHeavy },
  flexChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.08)", borderWidth: 1, borderColor: "rgba(58,50,71,0.2)" },
  flexTxt: { color: T.aubergine, fontSize: 12, fontFamily: font.bodyHeavy },

  miniMap: { height: 150, borderRadius: 16, overflow: "hidden", backgroundColor: "#e9e3dc", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", position: "relative" },
  road: { position: "absolute", height: 10, backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 6 },
  locPin: { position: "absolute", left: "44%", top: "40%", width: 38, height: 38, borderRadius: 999, backgroundColor: T.terra, alignItems: "center", justifyContent: "center" },

  glass: { borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", borderRadius: 18, backgroundColor: "rgba(255,255,255,0.85)", padding: 16 },
  bigRating: { fontSize: 32, fontFamily: font.head, color: T.ink, lineHeight: 32 },
  rbRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  rbStar: { flexDirection: "row", alignItems: "center", gap: 3, width: 34 },
  rbStarTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.ink },
  rbTrack: { flex: 1, height: 7, borderRadius: 999, backgroundColor: T.line, overflow: "hidden" },
  rbFill: { height: "100%", borderRadius: 999, backgroundColor: T.saffron },
  rbN: { width: 26, textAlign: "right", fontSize: 12, color: T.muted, fontFamily: font.body },
  reviewCard: { borderWidth: 1, borderColor: "rgba(255,255,255,0.66)", borderRadius: 18, backgroundColor: "rgba(255,255,255,0.85)", padding: 14 },
  rvAvatar: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  rvAvatarTxt: { color: "#fff", fontFamily: font.headHeavy, fontSize: 14 },
  rvName: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  rvWhen: { fontSize: 12, color: T.muted, fontFamily: font.body },
  rvText: { fontSize: 13, lineHeight: 20, marginTop: 12, color: T.ink, fontFamily: font.body },
  ghostBtn: { minHeight: 52, borderRadius: 18, alignItems: "center", justifyContent: "center", marginTop: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostBtnTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
  fsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: T.line },
  fsTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  fChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  fChipActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  fChipTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.aubergine },
  sortPill: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  sortPillActive: { backgroundColor: T.terra, borderColor: T.terra },
  sortTxt: { fontSize: 11.5, fontFamily: font.bodyBold, color: T.muted },

  ctaBar: {
    position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 14,
    paddingVertical: 12, paddingLeft: 18, paddingRight: 14, borderRadius: 24,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.97)",
    shadowColor: "#221f27", shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.22, shadowRadius: 40, elevation: 16,
  },
  ctaPrice: { fontSize: 19, fontFamily: font.headHeavy, color: T.ink },
  ctaUnit: { fontSize: 12, fontFamily: font.bodySemi, color: T.muted },
  ctaMeta: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  ctaBtn: { flex: 1, borderRadius: 16, overflow: "hidden" },
  ctaBtnInner: { minHeight: 50, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  ctaBtnTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
});

export { rupee };
