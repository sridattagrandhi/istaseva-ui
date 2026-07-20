// design/primitives.tsx — shared UI ported from the prototype ui.jsx + styles.css.
// RN note: CSS backdrop-filter glass is approximated with translucent solid fills.
import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ViewStyle,
  TextStyle,
  StyleProp,
} from "react-native";
import { Icon } from "./Icon";
import { T, font, radius, space, shadowSm, toneOf, Tone, rupee, noOutline } from "./theme";
import { useLanguage } from "@/contexts/LanguageContext";

/* ---------- Text helpers ---------- */
export function Txt(props: React.ComponentProps<typeof Text>) {
  return <Text {...props} style={[{ color: T.ink, fontFamily: font.body }, props.style]} />;
}

/* ---------- Striped placeholder "image" ---------- */
export function Ph({
  tone = "saffron",
  icon,
  label,
  style,
}: {
  tone?: Tone;
  icon?: string;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const c = toneOf(tone);
  return (
    <View style={[styles.ph, { backgroundColor: c.soft }, style]}>
      {icon ? <Icon name={icon} size={30} color={"rgba(58,50,71,0.32)"} strokeWidth={1.6} /> : null}
      {label ? (
        <Text style={styles.phLabel} numberOfLines={1}>
          {label.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

/* ---------- Star rating inline value ---------- */
export function RatingLine({
  rating,
  reviews,
  verified,
  extra,
}: {
  rating: number;
  reviews?: number;
  verified?: boolean;
  extra?: React.ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.ratingLine}>
      <Icon name="starFill" size={13} color={T.saffron} />
      <Text style={styles.ratingStrong}>{rating}</Text>
      {reviews != null ? <Text style={styles.muted12}>({reviews})</Text> : null}
      {verified ? (
        <View style={styles.verified}>
          <Icon name="badge" size={13} color={T.terra} />
          <Text style={styles.verifiedTxt}>{t("m.primitives.verified", { defaultValue: "Verified" })}</Text>
        </View>
      ) : null}
      {extra}
    </View>
  );
}

/* ---------- App bar ---------- */
export function AppBar({
  title,
  sub,
  onBack,
  right,
}: {
  title?: string;
  sub?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.appbar}>
      {onBack ? (
        <IconBtn name="chevL" onPress={onBack} />
      ) : null}
      <View style={{ flex: 1 }}>
        {title ? <Text style={styles.appbarTitle}>{title}</Text> : null}
        {sub ? <Text style={styles.appbarSub}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/* ---------- Section header ---------- */
export function SectionHead({
  eyebrow,
  title,
  action,
  onAction,
}: {
  eyebrow?: string;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.secHead}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text> : null}
        <Text style={styles.secTitle}>{title}</Text>
      </View>
      {action ? (
        <Pressable onPress={onAction} style={styles.secAction} hitSlop={8} accessibilityRole="button" accessibilityLabel={action}>
          <Text style={styles.secActionTxt}>{action}</Text>
          <Icon name="chevR" size={15} color={T.aubergine} />
        </Pressable>
      ) : null}
    </View>
  );
}

/* ---------- Icon button (glass) ---------- */
export function IconBtn({
  name,
  onPress,
  size = 22,
  bare,
  accessibilityLabel,
}: {
  name: string;
  onPress?: () => void;
  size?: number;
  bare?: boolean;
  /** Screen-reader name for this icon-only control. Falls back to the icon
   *  name so TalkBack/VoiceOver never announce an unlabeled button. */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? name}
      style={({ pressed, hovered }: any) => [
        bare ? styles.iconBtnBare : styles.iconBtn,
        hovered && { backgroundColor: "rgba(255,255,255,0.98)", transform: [{ scale: 1.04 }] },
        pressed && { transform: [{ scale: 0.94 }], opacity: 0.85 },
      ]}
      hitSlop={6}
    >
      <Icon name={name} size={size} color={T.aubergine} />
    </Pressable>
  );
}

/* ---------- Heart / wishlist toggle ----------
   Liked = filled red heart on a white chip; unliked = white outline heart on a dark chip. */
export const LIKE_RED = "#f2415f";
export function HeartBtn({ on, onPress }: { on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={on ? "Remove from wishlist" : "Add to wishlist"}
      accessibilityState={{ selected: on }}
      style={({ pressed, hovered }: any) => [
        styles.heartBtn,
        on && styles.heartBtnOn,
        hovered && { transform: [{ scale: 1.06 }] },
        pressed && { transform: [{ scale: 0.85 }] },
      ]}
      hitSlop={8}
    >
      <Icon name={on ? "heartFill" : "heart"} size={20} color={on ? LIKE_RED : "#fff"} strokeWidth={2} />
    </Pressable>
  );
}

/* ---------- Counter / stepper ---------- */
export function Counter({
  value,
  min = 0,
  max = 99,
  onChange,
  onLimit,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
  // Fired when the user taps a button that's already at the bound. When
  // provided, the bound button stays tappable (still styled disabled) so the
  // caller can surface a "that's the limit" notification. Without it, the
  // button is hard-disabled at the bound (original behavior).
  onLimit?: (which: "min" | "max") => void;
}) {
  const atMin = value <= min, atMax = value >= max;
  return (
    <View style={styles.counter}>
      <Pressable
        disabled={atMin && !onLimit}
        accessibilityRole="button"
        accessibilityLabel="Decrease"
        accessibilityState={{ disabled: atMin }}
        hitSlop={8}
        onPress={() => (atMin ? onLimit?.("min") : onChange(value - 1))}
        style={[styles.counterBtn, atMin && styles.counterDisabled]}
      >
        <Icon name="minus" size={16} color={T.aubergine} />
      </Pressable>
      <Text style={styles.counterVal} accessibilityLiveRegion="polite">{value}</Text>
      <Pressable
        disabled={atMax && !onLimit}
        accessibilityRole="button"
        accessibilityLabel="Increase"
        accessibilityState={{ disabled: atMax }}
        hitSlop={8}
        onPress={() => (atMax ? onLimit?.("max") : onChange(value + 1))}
        style={[styles.counterBtn, atMax && styles.counterDisabled]}
      >
        <Icon name="plus" size={16} color={T.aubergine} />
      </Pressable>
    </View>
  );
}

/* ---------- Tag / pill chip ---------- */
export function Tag({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return (
    <View style={styles.tag}>
      {icon ? <Icon name={icon} size={12} color={T.aubergine} /> : null}
      <Text style={styles.tagTxt}>{children}</Text>
    </View>
  );
}

/* ---------- Primary / outline button ---------- */
export function PrimaryButton({
  label,
  onPress,
  icon,
  style,
}: {
  label: string;
  onPress?: () => void;
  icon?: string;
  style?: StyleProp<ViewStyle>;
}) {
  // gradient approximated by a solid deep tone; LinearGradient version used in CTA bars
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed, hovered }: any) => [styles.btn, styles.btnPrimary, hovered && { opacity: 0.94, transform: [{ scale: 1.01 }] }, pressed && { transform: [{ scale: 0.98 }], opacity: 0.9 }, style]}
    >
      {icon ? <Icon name={icon} size={20} color="#fff" /> : null}
      <Text style={styles.btnPrimaryTxt}>{label}</Text>
    </Pressable>
  );
}

/* ---------- Generic touchable with press + hover feedback ----------
   Drop-in Pressable replacement for rows/buttons that need uniform tactile feedback. */
export function Touchable({
  children,
  onPress,
  style,
  scaleTo = 0.97,
  disabled,
  accessibilityLabel,
  accessibilityRole = "button",
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
  disabled?: boolean;
  /** Screen-reader name. Provide for rows whose visible text isn't enough
   *  context on its own (e.g. an icon row). */
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "link" | "none";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={onPress ? accessibilityRole : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed, hovered }: any) => [
        style,
        hovered && { opacity: 0.92 },
        pressed && { transform: [{ scale: scaleTo }], opacity: 0.85 },
      ]}
    >
      {children}
    </Pressable>
  );
}

/* ---------- Glass card wrapper ---------- */
export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /** Screen-reader name for a tappable card (e.g. the listing title). */
  accessibilityLabel?: string;
}) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed, hovered }: any) => [
        styles.card,
        hovered && styles.cardHover,
        pressed && { transform: [{ scale: 0.985 }], opacity: 0.96 },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/* ---------- Segmented control ---------- */
export function Segmented({
  options,
  value,
  onChange,
  small,
  faint,
  tabs,
}: {
  options: [string, string, string][]; // [key, icon, label]
  value: string;
  onChange: (k: string) => void;
  small?: boolean;
  faint?: boolean;
  /** Underlined text-tab variant (no pill container, no icons) — used for the
   *  top-level Explore segments. The pill variant stays the default. */
  tabs?: boolean;
}) {
  if (tabs) {
    return (
      <View style={styles.tabsRow}>
        {options.map(([k, , lb]) => {
          const active = value === k;
          return (
            <Pressable
              key={k}
              onPress={() => onChange(k)}
              accessibilityRole="button"
              accessibilityLabel={lb}
              accessibilityState={{ selected: active }}
              style={({ pressed }: any) => [styles.tabBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.tabTxt, active && styles.tabTxtActive]}>{lb}</Text>
              <View style={[styles.tabUnderline, active && styles.tabUnderlineActive]} />
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={[styles.segmented, faint && { backgroundColor: "rgba(255,255,255,0.4)" }]}>
      {options.map(([k, ic, lb]) => {
        const active = value === k;
        return (
          <Pressable
            key={k}
            onPress={() => onChange(k)}
            accessibilityRole="button"
            accessibilityLabel={lb}
            accessibilityState={{ selected: active }}
            style={({ pressed, hovered }: any) => [styles.segBtn, active && styles.segBtnActive, !active && hovered && { backgroundColor: "rgba(58,50,71,0.05)" }, pressed && { opacity: 0.8 }]}
          >
            <Icon name={ic} size={small ? 16 : 17} color={active ? "#fff" : T.muted} />
            <Text style={[styles.segTxt, active && { color: "#fff" }]}>{lb}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ---------- Search bar ---------- */
export function SearchBar({
  value,
  onChange,
  onClear,
  onFilter,
  placeholder,
  solid = false,
}: {
  value: string;
  onChange: (s: string) => void;
  onClear?: () => void;
  onFilter?: () => void;
  placeholder?: string;
  /** Opaque white background — for floating over busy surfaces (map tiles). */
  solid?: boolean;
}) {
  const { t } = useLanguage();
  const searching = value.length > 0;
  const ph = placeholder ?? t("m.primitives.searchPlaceholder", { defaultValue: "Search stays, services, rides…" });
  return (
    <View style={[styles.searchbar, solid && styles.searchbarSolid]}>
      <Icon name="search" size={20} color={T.terra} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={ph}
        placeholderTextColor="rgba(101,114,109,0.8)"
        accessibilityLabel={ph}
        style={styles.searchInput}
      />
      {searching ? (
        <IconBtn name="x" size={19} onPress={onClear} bare accessibilityLabel={t("m.primitives.clearSearch", { defaultValue: "Clear search" })} />
      ) : onFilter ? (
        <IconBtn name="sliders" size={20} onPress={onFilter} bare accessibilityLabel={t("m.primitives.filters", { defaultValue: "Filters" })} />
      ) : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  ph: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#e7e1da",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  phLabel: {
    fontFamily: "monospace",
    fontSize: 10.5,
    letterSpacing: 0.4,
    color: "rgba(58,50,71,0.5)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  ratingLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  ratingStrong: { color: T.ink, fontSize: 13, fontFamily: font.bodyBold },
  muted12: { color: T.muted, fontSize: 12.5, fontFamily: font.body },
  verified: { flexDirection: "row", alignItems: "center", gap: 3 },
  verifiedTxt: { color: T.terra, fontFamily: font.bodyBold, fontSize: 12.5 },

  appbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  appbarTitle: { fontSize: 20, fontFamily: font.head, color: T.ink, letterSpacing: -0.2 },
  appbarSub: { fontSize: 12.5, color: T.muted, fontFamily: font.body },

  secHead: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 22,
    marginBottom: 13,
  },
  eyebrow: {
    color: T.aubergine,
    fontSize: 12,
    fontFamily: font.bodyHeavy,
    letterSpacing: 1,
    marginBottom: 4,
  },
  secTitle: { fontSize: 21, fontFamily: font.head, color: T.ink, letterSpacing: -0.2 },
  secAction: { flexDirection: "row", alignItems: "center", gap: 3 },
  secActionTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },

  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    backgroundColor: "rgba(255,255,255,0.85)",
    ...shadowSm,
    shadowOpacity: 0.05,
  },
  iconBtnBare: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },

  heartBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 2,
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(23,20,29,0.38)",
  },
  heartBtnOn: { backgroundColor: "rgba(255,255,255,0.95)" },

  counter: { flexDirection: "row", alignItems: "center", gap: 14 },
  counterBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: T.line,
    backgroundColor: "rgba(255,255,255,0.7)",
  },
  counterDisabled: { opacity: 0.35 },
  counterVal: { fontSize: 16, fontFamily: font.bodyBold, minWidth: 22, textAlign: "center" },

  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(58,50,71,0.07)",
  },
  tagTxt: { color: T.aubergine, fontSize: 11.5, fontFamily: font.bodyBold },

  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    minHeight: 56,
    width: "100%",
    borderRadius: 18,
  },
  btnPrimary: { backgroundColor: T.aubergine, ...shadowSm, shadowColor: "#3a3247", shadowOpacity: 0.28 },
  btnPrimaryTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },

  card: {
    borderRadius: radius.card,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.66)",
    backgroundColor: "rgba(255,255,255,0.92)",
    ...shadowSm,
  },
  cardHover: { transform: [{ translateY: -2 }], borderColor: "rgba(139,94,74,0.3)" },

  segmented: {
    flexDirection: "row",
    gap: 4,
    padding: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.66)",
    backgroundColor: "rgba(255,255,255,0.6)",
  },
  segBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 42,
    borderRadius: 12,
  },
  segBtnActive: { backgroundColor: T.aubergine },
  segTxt: { color: T.muted, fontFamily: font.bodyHeavy, fontSize: 13.5 },

  // Underlined text-tab variant (tabs prop): a hairline divider spans the row
  // and the active tab draws a thicker terra bar over it.
  tabsRow: { flexDirection: "row", gap: 26, borderBottomWidth: 1, borderBottomColor: T.line },
  tabBtn: { alignItems: "center", paddingBottom: 11 },
  tabTxt: { color: T.muted, fontFamily: font.bodyHeavy, fontSize: 15.5 },
  tabTxtActive: { color: T.ink },
  tabUnderline: { position: "absolute", bottom: -1, left: 0, right: 0, height: 2, borderRadius: 2, backgroundColor: "transparent" },
  tabUnderlineActive: { backgroundColor: T.terra },

  searchbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 50,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    backgroundColor: "rgba(255,255,255,0.85)",
  },
  searchInput: { flex: 1, color: T.ink, fontFamily: font.body, fontSize: 15, paddingVertical: 0, ...noOutline },
  searchbarSolid: { backgroundColor: "#fff", borderColor: "rgba(58,50,71,0.08)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 18, elevation: 6 },
});

export { rupee };
