// design/screens/AiChatScreen.tsx — Ista AI assistant. Real agent loop (POST /api/assistant)
// when signed in; canned mock responses for the signed-out demo.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, Image, ActivityIndicator, KeyboardAvoidingView, Platform, NativeSyntheticEvent, NativeScrollEvent, Animated, Easing } from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "../Icon";
import { ChatText } from "../ChatText";
import { T, font, rupee, noOutline } from "../theme";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDesign } from "../DesignContext";
import {
  askAssistant, AssistantAction, ChatMsg, ChatPreparedBooking, InlineListingHit, InlineBooking, BookingInsights,
  CancelBookingRequest, HostMessageDraft, parsePreparedBooking, parseListingHits,
  parseInlineBookings, parseInsights, parseCancelRequest, parseHostMessageDraft,
  prepareBookingFromAction,
} from "../api/assistant";
import type { RootParamList } from "../Navigator";

// Narrow navigation surface — typed RootParamList navigation can't express the
// nested tab targets used here (navigate("Tabs", { screen: "Explore", … })).
type Nav = { navigate: (screen: string, params?: object) => void; goBack: () => void };
import { payPreparedBooking, PaymentCancelledError } from "../api/payment";
import { useVoiceLive } from "../api/voiceLive";
import { createVoiceAudioIO, liveVoiceAudioAvailable } from "../api/voiceAudioIO";
import { loadChatSession, saveChatSession, resetChatSession } from "../chatSession";
import { ListingCardsInline, BookingsListInline, InsightsStripInline, CancelBookingCard, MessageHostCard, listingBucket } from "./chatCards";
import { intentFromApplyFilters } from "./FilterSheet";

type Msg = {
  who: "ai" | "me";
  t?: string;
  booking?: ChatPreparedBooking;
  hits?: InlineListingHit[];
  bookings?: InlineBooking[];
  insights?: BookingInsights;
  cancel?: CancelBookingRequest;
  hostMsg?: HostMessageDraft;
  /** Failed turn — the exact args to replay on "Tap to retry". */
  retry?: { history: Msg[]; text: string };
  /** Signed-out nudge — renders a Sign in button under the bubble. */
  signIn?: boolean;
  /** Live-voice streaming bubble id — lets transcript chunks append to the
   *  in-progress bubble instead of spawning a new one per chunk. */
  vid?: number;
};

// Map an assistant action onto the right detail screen.
const SCREEN_FOR: Record<string, string> = { stay: "StayDetail", service: "ServiceDetail", transport: "TransportDetail" };
const SEG_FOR: Record<string, string> = { stay: "stays", service: "services", transport: "transport" };

/** Map the agent's web paths (it thinks in web routes) onto mobile screens. */
function routeForPath(path: string): { screen: string; params?: Record<string, unknown> } | null {
  if (path.startsWith("/dashboard/host") || path.startsWith("/become-host")) return { screen: "Dashboard" };
  if (path.startsWith("/dashboard")) return { screen: "Tabs", params: { screen: "Bookings" } };
  if (path.startsWith("/messages")) return { screen: "Tabs", params: { screen: "Messages" } };
  if (path.startsWith("/login") || path.startsWith("/signup")) return { screen: "Onboarding" };
  if (path === "/" || path.startsWith("/explore") || path.startsWith("/services") || path.startsWith("/transport")) {
    return { screen: "Tabs", params: { screen: "Explore" } };
  }
  return null;
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

const suggestionList = (t: TFn): [string, string][] => [
  ["landmark", t("m.aichat.suggestTempleTrip", { defaultValue: "Plan a 2-day temple trip" })],
  ["ticket", t("m.aichat.suggestStayDriver", { defaultValue: "Find a stay and a driver for the weekend" })],
  ["zap", t("m.aichat.suggestSalon", { defaultValue: "Book a salon appointment tomorrow morning" })],
];

const greetingMsg = (t: TFn): Msg => ({
  who: "ai",
  t: t("m.aichat.greeting", { defaultValue: "Namaskaram! 🙏 I'm Ista AI. Tell me what you need — a stay, a ride, a service, or a full plan — and I'll set it up." }),
});

// "2026-06-15" → "Mon, Jun 15"
function fmtDay(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  if (!iso || Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

const holdSecondsLeft = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((t - Date.now()) / 1000));
};

/**
 * Inline Confirm & Pay card — rendered when the agent's prepare_booking tool
 * locked a hold + order (action `prepare_booking_done`). Mirrors the web
 * BookingConfirmCard: countdown on the 5-min hold, server-authoritative total,
 * tap → checkout (native Razorpay or dev mock) → verify.
 */
function ConfirmPayCard({ booking, payer, onDone }: {
  booking: ChatPreparedBooking;
  payer: { name?: string; email?: string };
  onDone: (ok: boolean, text: string) => void;
}) {
  const { t } = useLanguage();
  type CardState = "ready" | "paying" | "success" | "failed" | "expired";
  // A restored session can remount this card long after its 5-min hold died —
  // start expired instead of flashing a payable button for the first tick.
  const [state, setState] = useState<CardState>(() => {
    const left = holdSecondsLeft(booking.holdExpiresAt);
    return left !== null && left <= 0 ? "expired" : "ready";
  });
  const [secs, setSecs] = useState<number | null>(() => holdSecondsLeft(booking.holdExpiresAt));

  useEffect(() => {
    if (state !== "ready" || secs === null) return;
    const id = setInterval(() => {
      const s = holdSecondsLeft(booking.holdExpiresAt);
      setSecs(s);
      if (s !== null && s <= 0) setState("expired");
    }, 1000);
    return () => clearInterval(id);
  }, [booking.holdExpiresAt, state, secs === null]);

  const pay = async () => {
    setState("paying");
    try {
      const res = await payPreparedBooking(booking, { ...payer, description: booking.listing.name });
      setState("success");
      // pending = Razorpay authorized but not yet captured — the booking
      // confirms when the payment.captured webhook lands. Don't claim
      // "confirmed" for a payment that could still fail capture.
      onDone(true, res.pending
        ? t("m.aichat.paymentProcessing", { defaultValue: "Payment received — {{name}} will be confirmed once the payment finishes processing. Check your Bookings shortly.", name: booking.listing.name })
        : t("m.aichat.bookedConfirmed", { defaultValue: "Booked! {{name}} is confirmed — you'll find it under your Bookings.", name: booking.listing.name }));
    } catch (e) {
      if (e instanceof PaymentCancelledError) { setState("ready"); return; } // hold stays live
      setState("failed");
      onDone(false, (e as { message?: string } | undefined)?.message || t("m.aichat.paymentFailed", { defaultValue: "Payment failed. Try again or pick another listing." }));
    }
  };

  const sched = booking.transport?.mode === "day"
    ? `${fmtDay(booking.schedule.scheduledDate)} · ${t("m.aichat.dayRental", { defaultValue: "Day rental" })}${booking.transport.days && booking.transport.days > 1 ? ` · ${t("m.aichat.daysCount", { defaultValue: "{{count}} days", count: booking.transport.days })}` : ""}`
    : booking.schedule.checkOutDate
      ? `${fmtDay(booking.schedule.scheduledDate)} → ${fmtDay(booking.schedule.checkOutDate)}${booking.schedule.nights ? ` · ${booking.schedule.nights === 1 ? t("m.aichat.nightCountOne", { defaultValue: "{{count}} night", count: booking.schedule.nights }) : t("m.aichat.nightCountOther", { defaultValue: "{{count}} nights", count: booking.schedule.nights })}` : ""}`
      : `${fmtDay(booking.schedule.scheduledDate)} · ${booking.schedule.startTime}–${booking.schedule.endTime}`;

  const mmss = secs !== null ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : null;
  const busy = state === "paying";

  return (
    <View style={s.payCard}>
      <View style={{ flexDirection: "row", gap: 11 }}>
        {!!booking.listing.image && /^https?:/.test(booking.listing.image) && (
          <Image source={{ uri: booking.listing.image }} style={s.payImg} />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.plStrong} numberOfLines={1}>{booking.listing.name}</Text>
          {!!booking.listing.location && <Text style={s.plSub} numberOfLines={1}>{booking.listing.location}</Text>}
          {!!booking.room?.name && <Text style={s.plSub} numberOfLines={1}>{booking.room.name}</Text>}
          <Text style={[s.plSub, { marginTop: 2 }]}>{sched}</Text>
          {booking.transport && (
            <Text style={s.plSub}>
              {booking.transport.mode === "hourly" ? `${t("m.aichat.hourly", { defaultValue: "Hourly" })}${booking.transport.hours ? ` · ${t("m.aichat.hoursShort", { defaultValue: "{{count}} hr", count: booking.transport.hours })}` : ""}` : booking.transport.mode === "package" ? t("m.aichat.package", { defaultValue: "Package" }) : t("m.aichat.dayRental", { defaultValue: "Day rental" })}
              {booking.transport.passengerCount ? ` · ${t("m.aichat.paxCount", { defaultValue: "{{count}} pax", count: booking.transport.passengerCount })}` : ""}
            </Text>
          )}
          {booking.insurance?.included && (
            <Text style={[s.plSub, { color: T.terra }]}>{t("m.aichat.protectionIncluded", { defaultValue: "Protection included" })}{booking.insurance.amount > 0 ? ` · ${rupee(booking.insurance.amount)}` : ""}</Text>
          )}
        </View>
      </View>
      <View style={s.payTotalRow}>
        <View>
          <Text style={s.plSub}>{t("m.aichat.total", { defaultValue: "Total" })}</Text>
          <Text style={s.payTotal}>{rupee(booking.amount)}</Text>
        </View>
        {(state === "ready" || state === "paying") && mmss !== null && (
          <Text style={[s.plSub, secs !== null && secs < 60 && { color: T.coral }]}>{t("m.aichat.hold", { defaultValue: "Hold {{time}}", time: mmss })}</Text>
        )}
      </View>
      <Pressable disabled={busy || state === "success" || state === "expired"} onPress={pay} style={{ marginTop: 11, borderRadius: 14, overflow: "hidden", opacity: state === "expired" ? 0.55 : 1 }}>
        <LinearGradient colors={state === "success" ? ["#2e7d52", "#2e7d52"] : [T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.bookBtn, { flexDirection: "row", gap: 8 }]}>
          {busy && <ActivityIndicator size="small" color="#fff" />}
          <Text style={s.bookTxt}>
            {state === "success" ? t("m.aichat.btnBooked", { defaultValue: "Booked ✓" })
              : state === "expired" ? t("m.aichat.btnExpired", { defaultValue: "Hold expired — ask me to book again" })
              : busy ? t("m.aichat.btnOpeningCheckout", { defaultValue: "Opening checkout…" })
              : state === "failed" ? t("m.aichat.btnPaymentFailed", { defaultValue: "Payment failed — tap to retry" })
              : t("m.aichat.btnConfirmPay", { defaultValue: "Confirm & Pay {{amount}}", amount: rupee(booking.amount) })}
          </Text>
        </LinearGradient>
      </Pressable>
    </View>
  );
}

// "Thinking" indicator shown while the agent turn is in flight. The three
// dots fade + lift in a staggered loop (each offset by its index, with a
// trailing delay that keeps every dot's cycle the same length so they stay
// phase-locked). Native-driven so it stays smooth while the JS thread is busy
// parsing the reply. The loop is stopped on unmount (busy → false).
function Typing({ label }: { label: string }) {
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    const anims = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(d, { toValue: 1, duration: 320, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 320, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.delay((dots.length - 1 - i) * 160),
        ]),
      ),
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [dots]);
  return (
    <View
      style={[s.bubble, s.bubbleAi, { flexDirection: "row", gap: 5, paddingVertical: 15 }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={[
            s.typingDot,
            {
              opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
            },
          ]}
        />
      ))}
    </View>
  );
}


export function AiChatScreen() {
  const { t } = useLanguage();
  const GREETING = greetingMsg(t);
  const SUGGESTIONS = suggestionList(t);
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<RootParamList, "AiChat">>();
  // Where the chat was opened from — forwarded to the backend so its
  // surface-specific persona (discovery/dashboard/…) kicks in.
  const ctxPath: string | undefined = route.params?.path;
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  // The thread survives this screen unmounting (every card tap navigates
  // away) via the app-lifetime session store — owner-scoped so a different
  // account never sees it, gone when the app process dies.
  const uid = user?.id ?? null;
  const restored = loadChatSession<Msg>(uid);
  const [msgs, setMsgs] = useState<Msg[]>(() => restored?.msgs ?? [GREETING]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(() => restored?.suggestions ?? []);
  const feedRef = useRef<ScrollView>(null);
  const { applyWish } = useDesign();
  const queryClient = useQueryClient();
  // Live (Gemini) voice: a single audio adapter for the screen's lifetime, plus
  // refs tracking the in-progress streaming bubble per role so transcript chunks
  // append rather than spawn a bubble each. Null when the native audio modules
  // aren't installed — the button is then hidden.
  const [voiceIO] = useState(() => (liveVoiceAudioAvailable ? createVoiceAudioIO() : null));
  const liveIds = useRef<{ me: number | null; ai: number | null }>({ me: null, ai: null });
  const voiceMsgId = useRef(1);
  // Gemini Live re-answers without a user turn in between (echo pickup,
  // barge-in regeneration) — without these flags the same answer stacks
  // up 3× in slightly different words. Mirrors the web AssistantWidget:
  // a post-turn_complete generation with NO user speech since replaces
  // the previous bubble instead of adding a duplicate.
  const aiTurnDoneRef = useRef(false);
  const userSpokeSinceTurnRef = useRef(false);
  // Write-through: every thread change lands in the session store, so the
  // latest state is what a remount restores. (A reply that arrives after
  // unmount is dropped with the component — acceptable; the user's message
  // is already saved and a resend replays it.)
  useEffect(() => { saveChatSession(uid, msgs, suggestions); }, [uid, msgs, suggestions]);
  const newChat = () => {
    if (busy) return;
    resetChatSession();
    setMsgs([GREETING]);
    setSuggestions([]);
    setVal("");
    atBottomRef.current = true;
  };

  // Follow the conversation: stick to the bottom while new content arrives,
  // but stop following the moment the user scrolls up to read history. The
  // pin re-arms when they scroll back to (near) the bottom.
  const atBottomRef = useRef(true);
  const onFeedScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 48;
  };
  const onFeedGrow = () => { if (atBottomRef.current) feedRef.current?.scrollToEnd({ animated: true }); };

  // Act on the assistant's UI action. Cards (listings/bookings/cancel/…) are
  // attached to the message in realRespond — this handles the rest: listing
  // navigation, page navigation, auth gate, and wishlist sync.
  const handleAction = (action?: AssistantAction) => {
    if (!action) return;
    const p = action.params || {};
    // Brief delay so the user reads the reply before the chat closes under them.
    const go = (screen: string, params?: Record<string, unknown>) =>
      setTimeout(() => { nav.goBack(); nav.navigate(screen, params); }, 700);
    switch (action.type) {
      case "open_listing":
      case "start_booking":
      case "view_listing": {
        const screen = SCREEN_FOR[p.listingType as string];
        if (p.listingId && screen) go(screen, { id: p.listingId });
        return;
      }
      case "locate_listing":
      case "highlight_listing": {
        // Mirror web's highlightMarketplaceCard: point at the card in the
        // Explore grid (scroll + flash) instead of bouncing to the detail
        // page. Explore falls back to opening the detail page itself if the
        // card isn't in its currently-loaded list.
        if (p.listingId) {
          const seg = SEG_FOR[p.listingType as string] ?? "stays";
          go("Tabs", {
            screen: "Explore",
            params: { locateIntent: { id: String(p.listingId), seg, listingType: p.listingType }, locateNonce: Date.now() },
          });
        }
        return;
      }
      case "navigate": {
        const r = typeof p.path === "string" ? routeForPath(p.path) : null;
        if (r) go(r.screen, r.params);
        return;
      }
      case "view_bookings":
        go("Tabs", { screen: "Bookings" });
        return;
      case "become_host":
        go("Dashboard");
        return;
      case "auth_required":
        go("Onboarding"); // sign-in lives on the onboarding screen
        return;
      case "wishlist_updated":
        // The agent's toggle_wishlist tool already persisted server-side —
        // mirror it locally so hearts flip without a refetch.
        if (typeof p.listingId === "string") applyWish(p.listingId, p.action !== "remove");
        return;
      case "apply_filters": {
        // filter_marketplace tool → narrow the Explore tab in place. Translate
        // the payload into the Explore screen's segment/tab/Filters shape and
        // navigate there (nonce forces a re-apply when state already matches).
        const intent = intentFromApplyFilters(p);
        if (intent) {
          setTimeout(
            () => { nav.goBack(); nav.navigate("Tabs", { screen: "Explore", params: { applyIntent: intent, applyNonce: Date.now() } }); },
            700,
          );
        }
        return;
      }
      case "search": {
        // The server prompt also emits a flat `search` action (query/city/
        // maxPrice at the top level, not under `filters`). Web narrows the
        // marketplace grid with it; mirror by translating into the same
        // Explore intent apply_filters uses. Was silently dropped before.
        const num = (v: unknown) => (v == null || v === "" || isNaN(Number(v)) ? undefined : Number(v));
        const q = p.query || p.location || p.city;
        const intent = intentFromApplyFilters({
          category: typeof p.category === "string" ? p.category : "stay",
          filters: { q: q ? String(q) : undefined, maxPrice: num(p.maxPrice), minRating: num(p.minRating) },
        });
        if (intent) {
          setTimeout(
            () => { nav.goBack(); nav.navigate("Tabs", { screen: "Explore", params: { applyIntent: intent, applyNonce: Date.now() } }); },
            700,
          );
        }
        return;
      }
      case "prepare_booking": {
        // LEGACY path (ASSISTANT_TOOL_LOOP=0): the agent emitted booking args
        // without running its tool, so the client creates the hold itself and
        // attaches the same Confirm & Pay card prepare_booking_done uses.
        // Without this case, AI-assisted booking dead-ended on mobile in
        // default (non-tool-loop) server config.
        if (!p.listingId || !p.scheduledDate) {
          appendNote(t("m.aichat.prepMissingDetails", { defaultValue: "I tried to prepare a booking but was missing details. Ask again with a specific listing and date." }));
          return;
        }
        void (async () => {
          try {
            const booking = await prepareBookingFromAction({
              listingId: String(p.listingId),
              scheduledDate: String(p.scheduledDate),
              checkOutDate: p.checkOutDate ? String(p.checkOutDate) : undefined,
              startTime: p.startTime ? String(p.startTime) : undefined,
              endTime: p.endTime ? String(p.endTime) : undefined,
              notes: p.notes ? String(p.notes) : undefined,
            });
            setMsgs((prev) => [...prev, { who: "ai", t: t("m.aichat.lockedIn", { defaultValue: "Locked in {{name}} — confirm below to pay.", name: booking.listing.name }), booking }]);
          } catch (e) {
            const err = e as { message?: string; response?: { data?: { error?: { message?: string } } } };
            appendNote(t("m.aichat.prepFailed", {
              defaultValue: "Couldn't lock that slot: {{reason}}",
              reason: err?.response?.data?.error?.message || err?.message || t("m.aichat.tryAnotherSlot", { defaultValue: "try another listing or date." }),
            }));
          }
        })();
        return;
      }
    }
  };

  // Append a live-voice transcript chunk to the in-progress bubble for `role`,
  // or open a new bubble. When the assistant starts replying we close the user's
  // bubble so the next user turn starts fresh. An assistant generation that
  // starts after turn_complete with NO user speech in between is a
  // re-generation (echo / barge-in) — it REPLACES the previous bubble's text
  // instead of stacking a near-duplicate answer.
  const streamVoice = (role: "me" | "ai", chunk: string) => {
    if (role === "me") {
      userSpokeSinceTurnRef.current = true;
      setMsgs((p) => {
        const liveId = liveIds.current.me;
        if (liveId != null) return p.map((m) => (m.vid === liveId ? { ...m, t: (m.t ?? "") + chunk } : m));
        const vid = voiceMsgId.current++;
        liveIds.current.me = vid;
        return [...p, { who: "me", t: chunk, vid }];
      });
      return;
    }
    if (liveIds.current.me != null) liveIds.current.me = null;
    const prevVid = liveIds.current.ai;
    const newGeneration = aiTurnDoneRef.current || prevVid == null;
    const regenerated = newGeneration && prevVid != null && !userSpokeSinceTurnRef.current;
    aiTurnDoneRef.current = false;
    if (regenerated) {
      setMsgs((p) => p.map((m) => (m.vid === prevVid ? { ...m, t: chunk } : m)));
      return;
    }
    if (newGeneration) {
      const vid = voiceMsgId.current++;
      liveIds.current.ai = vid;
      setMsgs((p) => [...p, { who: "ai", t: chunk, vid }]);
      return;
    }
    setMsgs((p) => p.map((m) => (m.vid === prevVid ? { ...m, t: (m.t ?? "") + chunk } : m)));
  };
  // The live Gemini voice session (mic ⇄ /ws/voice ⇄ Vertex). Transcripts stream
  // into bubbles; ui_action routes through the same handleAction switch as text.
  const voice = useVoiceLive(
    voiceIO,
    {
      onUserTranscript: (c) => streamVoice("me", c),
      onAssistantTranscript: (c) => streamVoice("ai", c),
      // Keep the ai bubble id across the boundary: a no-user-turn
      // regeneration must be able to replace the bubble it belongs to.
      onTurnComplete: () => { liveIds.current.me = null; aiTurnDoneRef.current = true; userSpokeSinceTurnRef.current = false; },
      onUiAction: (e) => handleAction({ type: e.action, params: e.params }),
    },
    { mode: "sathi" },
  );
  const voiceActive = voice.state === "connecting" || voice.state === "listening" || voice.state === "speaking";
  const toggleVoice = () => {
    if (!voiceIO) return;
    if (voiceActive) voice.stop();
    else voice.start();
  };
  const voiceLabel =
    voice.state === "connecting" ? t("m.aichat.voiceConnecting", { defaultValue: "Connecting…" })
    : voice.state === "listening" ? t("m.aichat.voiceListening", { defaultValue: "Listening — speak now" })
    : voice.state === "speaking" ? t("m.aichat.voiceSpeaking", { defaultValue: "Ista is speaking…" })
    : voice.state === "permission_denied" ? t("m.aichat.voiceMicDenied", { defaultValue: "Microphone permission needed" })
    : voice.state === "error" ? (voice.lastError ?? t("m.aichat.voiceError", { defaultValue: "Voice unavailable right now" }))
    : "";

  // Real assistant — sends the running conversation to the agent loop.
  const realRespond = async (history: Msg[], text: string) => {
    setBusy(true);
    setSuggestions([]);
    try {
      // Error bubbles and sign-in nudges are UI chrome, not conversation —
      // keep them out of what the agent sees.
      const payload: ChatMsg[] = [
        ...history.filter((m) => m.t && !m.retry && !m.signIn).map((m) => ({ role: m.who === "me" ? ("user" as const) : ("assistant" as const), content: m.t! })),
        { role: "user", content: text },
      ];
      const reply = await askAssistant(payload, { path: ctxPath });
      const replyText = reply.message || t("m.aichat.replyFallback", { defaultValue: "I'm here — tell me a bit more about what you need." });
      // Inline-card actions attach their payload to the bubble (Confirm & Pay,
      // listing cards, bookings list, insights, cancel/message-host gates);
      // everything else falls through to handleAction (navigation, wishlist).
      const a = reply.action;
      const booking = a?.type === "prepare_booking_done" ? parsePreparedBooking(a.params) : null;
      const hits = a?.type === "show_listing_cards" ? parseListingHits(a.params) : [];
      const inlineBookings = a?.type === "show_bookings" ? parseInlineBookings(a.params) : [];
      const insights = a?.type === "show_insights" ? parseInsights(a.params) : null;
      const cancel = a?.type === "confirm_cancel_booking" ? parseCancelRequest(a.params) : null;
      const hostMsg = a?.type === "confirm_message_host" ? parseHostMessageDraft(a.params) : null;
      const hasCard = !!(booking || hits.length || inlineBookings.length || insights || cancel || hostMsg);
      setMsgs((p) => [...p, {
        who: "ai", t: replyText,
        booking: booking ?? undefined,
        hits: hits.length ? hits : undefined,
        bookings: inlineBookings.length ? inlineBookings : undefined,
        insights: insights ?? undefined,
        cancel: cancel ?? undefined,
        hostMsg: hostMsg ?? undefined,
      }]);
      setSuggestions(reply.suggestions.slice(0, 3));
      if (!hasCard) handleAction(a);
    } catch {
      // Keep the failed turn's args on the bubble so "Tap to retry" can
      // replay it without the user retyping.
      setMsgs((p) => [...p, { who: "ai", t: t("m.aichat.networkTrouble", { defaultValue: "I'm having trouble reaching the network right now." }), retry: { history, text } }]);
    } finally {
      setBusy(false);
    }
  };

  // Replay a failed turn: drop the error bubble, re-run the same request.
  const doRetry = (m: Msg) => {
    if (busy || !m.retry) return;
    const { history, text } = m.retry;
    setMsgs((p) => p.filter((x) => x !== m));
    realRespond(history, text);
  };

  // Card resolutions append a follow-up note from the assistant.
  const appendNote = (text: string) => {
    setMsgs((p) => [...p, { who: "ai", t: text }]);
  };
  const goBookingsTab = () => { nav.goBack(); nav.navigate("Tabs", { screen: "Bookings" }); };
  const openHit = (hit: InlineListingHit) => {
    const screen = SCREEN_FOR[listingBucket(hit.type)];
    nav.goBack();
    nav.navigate(screen, { id: hit.id });
  };

  const send = (txt?: string) => {
    const trimmed = (txt ?? val).trim();
    if (!trimmed || busy) return;
    setVal("");
    setSuggestions([]);
    atBottomRef.current = true; // sending always snaps the feed back down
    const history = msgs;
    setMsgs((p) => [...p, { who: "me", t: trimmed }]);
    if (user) realRespond(history, trimmed);
    else setMsgs((p) => [...p, { who: "ai", t: t("m.aichat.signInNudge", { defaultValue: "Please sign in to use the IstaSeva assistant — I can find stays, plan trips and book rides once you're signed in." }), signIn: true }]);
  };

  return (
    <LinearGradient colors={["#f6f5f8", "#eef1f6", "#fbf6f1"]} start={{ x: 0.9, y: 0 }} end={{ x: 0.1, y: 1 }} style={{ flex: 1 }}>
      <View style={[s.head, { paddingTop: insets.top + 8 }]}>
        <LinearGradient colors={["#3a3247", "#8b5e4a"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.avatar}>
          <Icon name="bot" size={22} color="#fff" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Ista AI</Text>
          <Text style={s.sub}>{t("m.aichat.tripAssistant", { defaultValue: "Trip & booking assistant" })}</Text>
        </View>
        {msgs.length > 1 && (
          <Pressable style={s.closeBtn} onPress={newChat} accessibilityLabel={t("m.aichat.startNewChat", { defaultValue: "Start a new chat" })}>
            <Icon name="edit" size={19} color={T.aubergine} />
          </Pressable>
        )}
        <Pressable style={s.closeBtn} onPress={() => nav.goBack()}><Icon name="x" size={22} color={T.aubergine} /></Pressable>
      </View>

      {/* Android resizes the window itself (softwareKeyboardLayoutMode:
          resize); iOS needs the padding behavior so the composer rides up
          with the keyboard instead of hiding under it. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        ref={feedRef}
        contentContainerStyle={{ padding: 18, gap: 12 }}
        showsVerticalScrollIndicator={false}
        onScroll={onFeedScroll}
        scrollEventThrottle={32}
        onContentSizeChange={onFeedGrow}
      >
        {msgs.map((m, i) => (
          <React.Fragment key={i}>
            <View style={[s.bubble, m.who === "me" ? s.bubbleMe : s.bubbleAi]}>
              {m.who === "me"
                ? <Text style={[s.bubbleTxt, { color: "#fff" }]}>{m.t}</Text>
                : <ChatText text={m.t ?? ""} style={s.bubbleTxt} />}
            </View>
            {m.booking && (
              <ConfirmPayCard
                booking={m.booking}
                payer={{ name: user?.name, email: user?.email }}
                onDone={(ok, text) => {
                  setMsgs((p) => [...p, { who: "ai", t: text }]);
                  if (ok) {
                    queryClient.invalidateQueries({ queryKey: ["my-bookings"] });
                    queryClient.invalidateQueries({ queryKey: ["booked-dates", m.booking!.listing.id] });
                    queryClient.invalidateQueries({ queryKey: ["availability", m.booking!.listing.id] });
                    // BookingScreen greys occupied slots off these two keys —
                    // without them an assistant-made service/transport booking
                    // leaves the slot strip stale (root CLAUDE.md invariant).
                    queryClient.invalidateQueries({ queryKey: ["service-bookings", m.booking!.listing.id] });
                    queryClient.invalidateQueries({ queryKey: ["transport-bookings", m.booking!.listing.id] });
                  }
                }}
              />
            )}
            {m.hits && (
              <ListingCardsInline
                hits={m.hits}
                onOpen={openHit}
                // "Book" hands the listing back to the agent — its booking gate
                // + prepare_booking flow ends in the inline Confirm & Pay card.
                onBook={(hit) => send(`Book ${hit.title}`)}
              />
            )}
            {m.bookings && <BookingsListInline bookings={m.bookings} onManage={goBookingsTab} />}
            {m.insights && <InsightsStripInline insights={m.insights} onViewAll={goBookingsTab} />}
            {m.cancel && (
              <CancelBookingCard
                req={m.cancel}
                onDone={(ok, text) => {
                  appendNote(text);
                  if (ok) {
                    queryClient.invalidateQueries({ queryKey: ["my-bookings"] });
                  }
                }}
              />
            )}
            {m.hostMsg && <MessageHostCard draft={m.hostMsg} onDone={(_ok, text) => appendNote(text)} />}
            {m.retry && (
              <Pressable style={s.inlineAction} onPress={() => doRetry(m)} disabled={busy}>
                <Icon name="refresh" size={14} color={T.terra} />
                <Text style={s.inlineActionTxt}>{t("m.aichat.tapToRetry", { defaultValue: "Tap to retry" })}</Text>
              </Pressable>
            )}
            {m.signIn && (
              <Pressable style={s.inlineAction} onPress={() => nav.navigate("Onboarding")}>
                <Icon name="user" size={14} color={T.terra} />
                <Text style={s.inlineActionTxt}>{t("m.aichat.signIn", { defaultValue: "Sign in" })}</Text>
              </Pressable>
            )}
          </React.Fragment>
        ))}
        {busy && <Typing label={t("m.aichat.thinking", { defaultValue: "Ista AI is thinking…" })} />}
        {msgs.length === 1 && !busy && (
          <View style={{ gap: 9, marginTop: 6 }}>
            {SUGGESTIONS.map(([ic, t]) => (
              <Pressable key={t} style={s.suggestion} onPress={() => send(t)}>
                <Icon name={ic} size={17} color={T.terra} />
                <Text style={s.suggestionTxt}>{t}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {msgs.length > 1 && !busy && suggestions.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
            {suggestions.map((t) => (
              <Pressable key={t} style={s.chip} onPress={() => send(t)}>
                <Text style={s.chipTxt}>{t}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      {voiceIO && voice.state !== "idle" && !!voiceLabel && (
        <View style={[s.voicePill, (voice.state === "error" || voice.state === "permission_denied") && s.voicePillErr]}>
          {voice.state === "connecting" && <ActivityIndicator size="small" color="#fff" />}
          <Text style={s.voicePillTxt}>{voiceLabel}</Text>
        </View>
      )}
      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.field}>
          <Icon name="sparkle" size={18} color={T.terra} />
          <TextInput value={val} onChangeText={setVal} placeholder={t("m.aichat.askPlaceholder", { defaultValue: "Ask Ista AI…" })} placeholderTextColor={T.muted} style={s.input} onSubmitEditing={() => send()} returnKeyType="send" />
        </View>
        {/* Single live-voice mic toggle — same affordance as web: MicOff = tap to
            start, Mic (highlighted) = live / tap to stop. */}
        {liveVoiceAudioAvailable && (
          <Pressable style={[s.micBtn, voiceActive && s.micBtnOn]} onPress={toggleVoice} accessibilityLabel={voiceActive ? "Stop voice" : "Start voice"}>
            <Icon name={voiceActive ? "mic" : "micOff"} size={20} color={voiceActive ? "#fff" : T.aubergine} />
          </Pressable>
        )}
        <Pressable onPress={() => send()}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.sendBtn}>
            <Icon name="send" size={20} color="#fff" />
          </LinearGradient>
        </Pressable>
      </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 14 },
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 16, fontFamily: font.head, color: T.ink },
  sub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  closeBtn: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },

  bubble: { maxWidth: "82%", paddingVertical: 13, paddingHorizontal: 15, borderRadius: 20 },
  bubbleAi: { alignSelf: "flex-start", backgroundColor: "rgba(255,255,255,0.95)", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", borderTopLeftRadius: 6 },
  bubbleMe: { alignSelf: "flex-end", backgroundColor: T.aubergine, borderTopRightRadius: 6 },
  bubbleTxt: { fontSize: 14, lineHeight: 20, color: T.ink, fontFamily: font.body },
  typingDot: { width: 7, height: 7, borderRadius: 99, backgroundColor: "rgba(58,50,71,0.4)" },

  suggestion: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.8)" },
  suggestionTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.aubergine, flex: 1 },
  chip: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)", backgroundColor: "rgba(255,255,255,0.85)" },
  chipTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.terra },
  inlineAction: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)", backgroundColor: "rgba(255,255,255,0.85)" },
  inlineActionTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.terra },

  planCard: { borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.9)" },
  planLine: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: T.line },
  plIco: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  plStrong: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  plSub: { color: T.muted, fontSize: 12, fontFamily: font.body },
  plCost: { fontFamily: font.bodyHeavy, fontSize: 13.5, color: T.ink },
  bookBtn: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  bookTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 15 },

  payCard: { alignSelf: "stretch", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.95)" },
  payImg: { width: 58, height: 58, borderRadius: 12, backgroundColor: T.line },
  payTotalRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.line },
  payTotal: { fontSize: 19, fontFamily: font.headHeavy, color: T.ink },

  composer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  field: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.85)" },
  input: { flex: 1, fontFamily: font.body, fontSize: 15, color: T.ink, paddingVertical: 0, ...noOutline },
  sendBtn: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  micBtn: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  micBtnOn: { backgroundColor: T.coral, borderColor: T.coral },
  voicePill: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, alignSelf: "center", marginBottom: 8, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: T.aubergine },
  voicePillErr: { backgroundColor: T.coral },
  voicePillTxt: { color: "#fff", fontSize: 13, fontFamily: font.bodyBold },
  headBtnOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
});
