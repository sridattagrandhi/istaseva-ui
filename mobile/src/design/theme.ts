// design/theme.ts — tokens ported 1:1 from the Claude Design prototype (styles.css :root).
// This is the warm saffron/aubergine system, distinct from the legacy src/theme indigo set.

export const T = {
  bg: "#f6f6f8",
  surface: "#fbfbfd",
  surfaceStrong: "#ffffff",
  ink: "#17161c",
  muted: "#68707a",
  line: "rgba(23, 22, 28, 0.1)",
  terra: "#8b5e4a",
  aubergine: "#3a3247",
  deep: "#17141d",
  saffron: "#bd8752",
  coral: "#a45d62",
  blue: "#617a92",
  greenSoft: "#f1ece9",
  goldSoft: "#f7eee5",
  // gradient endpoints for --grad-primary: linear-gradient(135deg, #2b2436, #8b5e4a)
  gradFrom: "#2b2436",
  gradTo: "#8b5e4a",
} as const;

// Tone system used across cards / chips / placeholders. Each tone maps to a base
// color plus a soft tint used for backgrounds.
export type Tone = "saffron" | "coral" | "blue" | "aubergine";

export const TONES: Record<Tone, { base: string; soft: string; ink: string }> = {
  saffron: { base: "#bd8752", soft: "#f7eee5", ink: "#6f4a24" },
  coral: { base: "#a45d62", soft: "#f6e9ea", ink: "#6e3a3e" },
  blue: { base: "#617a92", soft: "#e9eef3", ink: "#37485a" },
  aubergine: { base: "#3a3247", soft: "#ece9f0", ink: "#2a2433" },
};

export const toneOf = (t?: string) => TONES[(t as Tone) in TONES ? (t as Tone) : "saffron"];

export const radius = {
  card: 18,
  pill: 999,
  chip: 14,
  btn: 14,
  sm: 12,
} as const;

export const space = {
  x2: 2,
  x4: 4,
  x6: 6,
  x8: 8,
  x10: 10,
  x12: 12,
  x14: 14,
  x16: 16,
  x18: 18,
  x20: 20,
  x24: 24,
  x28: 28,
  x32: 32,
} as const;

export const shadowSm = {
  shadowColor: "#221f27",
  shadowOffset: { width: 0, height: 16 },
  shadowOpacity: 0.08,
  shadowRadius: 28,
  elevation: 6,
} as const;

export const shadowMd = {
  shadowColor: "#221f27",
  shadowOffset: { width: 0, height: 24 },
  shadowOpacity: 0.16,
  shadowRadius: 48,
  elevation: 14,
} as const;

// Font families — registered in design/fonts.ts via @expo-google-fonts.
// Headings: Plus Jakarta Sans. Body: Inter.
export const font = {
  body: "Inter_400Regular",
  bodyMed: "Inter_500Medium",
  bodySemi: "Inter_600SemiBold",
  bodyBold: "Inter_700Bold",
  bodyHeavy: "Inter_800ExtraBold",
  head: "PlusJakartaSans_700Bold",
  headSemi: "PlusJakartaSans_600SemiBold",
  headHeavy: "PlusJakartaSans_800ExtraBold",
} as const;

// Money formatter — paise-exact. Amounts with paise render to the hundredth
// ("₹108.15", never "₹108"); whole-rupee amounts stay clean ("₹3").
export const rupee = (n: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "₹0";
  const abs = Math.abs(v);
  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const formatted = abs.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}₹${formatted}`;
};

// react-native-web renders TextInput as <input>, which shows a browser focus
// outline (the "yellow box"). Spread this into TextInput styles to remove it.
export const noOutline = { outlineStyle: "none", outlineWidth: 0, outlineColor: "transparent" } as any;
