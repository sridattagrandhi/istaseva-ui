import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Mic, MicOff, Radio, Send, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/contexts/AuthContext";
import { useSaved } from "@/contexts/SavedContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useLocation as useUserLocation } from "@/contexts/LocationContext";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import { useGeminiLiveVoice, isLiveVoiceEnabled } from "@/hooks/useGeminiLiveVoice";
import {
  getUserAssistantService,
  type UserAssistantAction,
  type PrepareBookingResult,
} from "@/domains/chat/user-assistant.service";
import { BookingConfirmCard } from "@/components/assistant/BookingConfirmCard";
import { CancelBookingCard } from "@/components/assistant/CancelBookingCard";
import { MessageHostCard } from "@/components/assistant/MessageHostCard";
import { ToolCallChip, type Chip } from "@/components/assistant/ToolCallChip";
import { ChatMarkdown, stripChatMarkdown } from "@/components/assistant/ChatMarkdown";
import { ListingCardsInline, type InlineListingHit } from "@/components/assistant/ListingCardsInline";
import { BookingsListInline, type InlineBooking } from "@/components/assistant/BookingsListInline";
import { InsightsStripInline, type BookingInsights } from "@/components/assistant/InsightsStripInline";
import { getRealtimeProvider } from "@/config/providers";
import { marketplaceAgentBus, highlightMarketplaceCard, type ApplyFiltersIntent } from "@/lib/marketplace-agent-bus";
import { cn } from "@/lib/utils";

// Phase 2: confirmation-card payloads attached to an assistant message
// after the agent emits a confirm_* action.
interface CancelConfirmation {
  bookingId: string;
  summary?: string;
}
interface MessageHostConfirmation {
  listingId: string;
  hostUserId: string;
  message: string;
  hostName?: string;
}
// Tool-progress events the server fires on `user:<uid>:assistant:<requestId>:tools`
// while the agent loop runs (type: tool_start / tool_done / tool_error).
interface ToolChannelEvent {
  type?: string;
  name?: string;
  argsSummary?: string;
  summary?: string;
  message?: string;
}

interface AssistantMsg {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  suggestions?: string[];
  // When the agent emits prepare_booking, we attach the prepared order to
  // the assistant's reply message and render an inline Confirm & Pay card.
  booking?: PrepareBookingResult;
  // Phase 2 confirmation cards.
  cancelConfirm?: CancelConfirmation;
  messageHostConfirm?: MessageHostConfirmation;
  // Phase 5: tool-call chips streamed via the realtime channel
  // user:<uid>:assistant:<requestId>:tools. Stored on the assistant message so they
  // render inline above the reply text once the bubble materialises.
  chips?: Chip[];
  // Inline listing cards rendered when the agent emits show_listing_cards.
  // The hits come straight from the search_listings tool result so the
  // user sees the same options the model is reasoning about.
  listingHits?: InlineListingHit[];
  /** Inline bookings list rendered when the agent emits show_bookings
   *  (promoted from a get_user_bookings tool result). */
  bookings?: InlineBooking[];
  /** Compact insights strip rendered when the agent emits show_insights
   *  (promoted from a get_booking_insights tool result). */
  insights?: BookingInsights;
  /** Phase 5: requestId that owns this bubble's chip stream. */
  requestId?: string;
}

// Tools that should NEVER surface as chips even if the server emits
// events for them. Mirrors the server-side HIDDEN_TOOLS in chip-emitter
// so the fallback path (rendering from response.toolCalls) skips them
// the same way.
const HIDDEN_CHIP_TOOLS = new Set(["remember_preference", "set_picker_action", "extract_fields"]);

function isUserVisibleClientChip(name: string): boolean {
  return !HIDDEN_CHIP_TOOLS.has(name);
}

// Pending-state label per tool. The server sends an `argsSummary` like
// "stay in Coorg" we paste in for search_listings; for narrower tools we
// use a short fixed verb so the chip isn't empty.
function pendingLabelFor(name: string, argsSummary?: string): string {
  switch (name) {
    case "search_listings":
      return argsSummary ? `Searching ${argsSummary}…` : "Searching…";
    case "get_listing_details":
      return "Loading details…";
    case "check_availability":
      return "Checking dates…";
    case "get_user_bookings":
      return "Looking up your bookings…";
    case "cancel_booking_preview":
      return "Pulling cancel details…";
    case "message_host_preview":
      return "Drafting message…";
    case "prepare_booking":
      return "Locking the slot…";
    case "resolve_address":
      return "Checking the address…";
    case "escalate_to_human":
      return "Looping in support…";
    default:
      return "Working on it…";
  }
}

// Greetings live in src/locales/*.json under `assistant.greeting`. The
// per-language strings used to be hardcoded here; moved out in Phase 2c
// so adding Bengali/Punjabi/Gujarati is a translation file, not a code
// change.

export function AssistantWidget() {
  const { isAuthenticated, user } = useAuth();
  const { applyServerSave } = useSaved();
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  // The user's real device location (LocationContext) — isDefault means the
  // Hampi placeholder, which must never be presented to the agent as where
  // the user actually is.
  const { location: userLoc, requestLocation } = useUserLocation();
  const queryClient = useQueryClient();
  // Same cache set MarketplaceBookingModal refreshes on booking success —
  // assistant-made bookings/cancellations must hit the identical keys or the
  // guest dashboard, partner dashboards, and slot-greying queries go stale
  // (the root CLAUDE.md "invalidate on every booking-success path" rule).
  const refreshBookingCaches = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["partner-bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["provider-bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["service-bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["transport-bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["transport-schedule"] }),
    ]);
  }, [queryClient]);
  const {
    voiceState, interimTranscript, isMuted, supportsSTT, supportsTTS,
    toggleListening, speak, setIsMuted, setLanguages, setOnTranscript,
  } = useVoiceAssistant();
  // Gemini Live native-audio voice — ON for all real users. The legacy
  // browser-STT path can't auto-detect language, so isLiveVoiceEnabled()
  // now returns true unless localStorage.sathi_voice_live === 'debug-legacy'
  // (an internal troubleshooting sentinel, not a user-facing opt-out).
  const liveEnabled = useMemo(isLiveVoiceEnabled, []);
  // Refs for the in-flight voice transcripts. Live transcripts arrive
  // as incremental chunks; we accumulate into these and commit to the
  // chat as proper messages on turn_complete.
  const userTurnIdRef = useRef<string | null>(null);
  const assistantTurnIdRef = useRef<string | null>(null);
  // Gemini Live re-answers without a user turn in between (echo pickup,
  // barge-in regeneration, tool-boundary re-fires) — the user saw the
  // same answer stacked 3× in slightly different words. These two flags
  // let onAssistantTranscript tell "new answer to new speech" (fresh
  // bubble) apart from "re-generation of the last answer" (replace the
  // previous bubble's content).
  const assistantTurnDoneRef = useRef(false);
  const userSpokeSinceTurnRef = useRef(false);

  const liveVoice = useGeminiLiveVoice({
    // User transcript chunks → append to the latest in-flight user
    // message bubble (or create one if this is the first chunk).
    onUserTranscript: (chunk) => {
      userSpokeSinceTurnRef.current = true;
      setMessages((prev) => {
        if (userTurnIdRef.current) {
          const idx = prev.findIndex((m) => m.id === userTurnIdRef.current);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...next[idx], content: next[idx].content + chunk };
            return next;
          }
        }
        const id = `voice-u-${Date.now()}`;
        userTurnIdRef.current = id;
        return [...prev, { id, role: "user", content: chunk }];
      });
    },
    // Assistant transcript chunks → same pattern, but on the assistant
    // bubble. A completed turn followed by more assistant output means a
    // NEW generation: if the user spoke in between it's a real new answer
    // (fresh bubble); if they didn't, the model re-answered on its own
    // (echo / interruption regen) and the new text REPLACES the previous
    // bubble instead of stacking a near-duplicate reply.
    onAssistantTranscript: (chunk) => {
      const prevId = assistantTurnIdRef.current;
      const newGeneration = assistantTurnDoneRef.current || prevId == null;
      const regenerated = newGeneration && prevId != null && !userSpokeSinceTurnRef.current;
      assistantTurnDoneRef.current = false;
      if (regenerated) {
        setMessages((prev) => prev.map((m) => (m.id === prevId ? { ...m, content: chunk } : m)));
        return;
      }
      if (newGeneration) {
        const id = `voice-a-${Date.now()}`;
        assistantTurnIdRef.current = id;
        setMessages((prev) => [...prev, { id, role: "assistant", content: chunk }]);
        return;
      }
      setMessages((prev) => prev.map((m) => (m.id === prevId ? { ...m, content: m.content + chunk } : m)));
    },
    // Commit turn boundaries. The user ref clears so their next utterance
    // opens a fresh bubble; the assistant ref is KEPT so a no-user-turn
    // regeneration can replace the bubble it belongs to (see above).
    onTurnComplete: () => {
      userTurnIdRef.current = null;
      assistantTurnDoneRef.current = true;
      userSpokeSinceTurnRef.current = false;
    },
    // The user's whole utterance came back unintelligible (bad audio /
    // Vertex misfire). Surface a gentle "didn't catch that" prompt instead
    // of silently dropping the turn, so it doesn't look like we ignored them.
    onNeedsRepeat: () => {
      setMessages((prev) => [
        ...prev,
        { id: `voice-repeat-${Date.now()}`, role: "assistant", content: t("assistant.didntCatch") },
      ]);
    },
    // Voice agent is calling a tool — render a chip in the in-flight
    // row so the user sees what's happening.
    onToolStart: (event) => {
      setInFlightChips((prev) => [
        ...prev,
        {
          id: `voice-chip-${event.name}-${Date.now()}-${prev.length}`,
          toolName: event.name,
          status: "pending",
          pendingLabel: pendingLabelFor(event.name, event.argsSummary),
        },
      ]);
    },
    onToolDone: (event) => {
      setInFlightChips((prev) => {
        // Find the most-recent pending chip for this tool name and flip
        // it to done. Simpler than tracking call ids since voice fires
        // tools sequentially (not parallel like the text agent).
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].toolName === event.name && next[i].status === "pending") {
            next[i] = { ...next[i], status: "done", doneLabel: event.summary };
            return next;
          }
        }
        return next;
      });
    },
    onToolError: (event) => {
      setInFlightChips((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].toolName === event.name && next[i].status === "pending") {
            next[i] = { ...next[i], status: "error", errorMessage: event.message };
            return next;
          }
        }
        return next;
      });
    },
    // Voice agent wants the UI to do something — currently just
    // navigation. Reuse the same logic the text path's `runAction`
    // uses so behavior stays consistent.
    onUiAction: (event) => {
      if (event.action === "navigate") {
        const params = event.params || {};
        const path = typeof params.path === "string" ? params.path : null;
        if (!path) return;
        const filters = (params.filters || {}) as Record<string, string>;
        const qs = new URLSearchParams();
        if (filters.location) qs.set("location", filters.location);
        if (filters.query) qs.set("q", filters.query);
        if (filters.category) qs.set("category", filters.category);
        navigate(qs.toString() ? `${path}?${qs}` : path);
        setOpen(false);
        return;
      }
      // Browsing intent (voice): "show me Trident" — open the listing page
      // WITHOUT a locked hold. For booking intent the voice agent uses
      // prepare_booking instead, which renders the Confirm & Pay card
      // right here in the chat. Don't close the chat — the agent's spoken
      // handoff line should still be visible/audible.
      if (event.action === "start_booking") {
        const listingId = (event.params || {}).listingId;
        if (typeof listingId === "string" && listingId) {
          navigate(`/stay/${listingId}?book=1`);
        }
        return;
      }
      // Booking intent (voice): prepare_booking succeeded server-side and
      // pushed the full payload here. ALWAYS append the card as a new
      // assistant message at the end of the thread — never try to
      // back-fill an earlier assistant bubble.
      //
      // Why: in voice the tool-call result often arrives BEFORE the
      // spoken transcript starts streaming, so "most recent assistant
      // without a booking" can still match the greeting at the top of
      // the chat. That puts the card above the user's question, which
      // is what the user just flagged. Pushing fresh at the bottom
      // matches chronological order: user spoke → card answers.
      //
      // The chat STAYS OPEN so the user can see and tap the card. No
      // navigation.
      if (event.action === "show_booking_card") {
        const booking = (event.params || {}) as unknown as PrepareBookingResult;
        if (!booking?.bookingId || !booking?.orderId) return;
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: `Locked in ${booking.listing.name} — confirm below to pay.`,
            booking,
          },
        ]);
        return;
      }
    },
  });
  const [open, setOpen] = useState(false);
  const [authGateOpen, setAuthGateOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Phase 5: chips for the in-flight request, rendered above the typing
  // indicator while the agent loop runs. Folded into the final assistant
  // message bubble when the response arrives, then cleared.
  const [inFlightChips, setInFlightChips] = useState<Chip[]>([]);
  // Mirror of inFlightChips so the post-await success path can read the
  // latest chips synchronously (state captured in the closure is stale
  // by then, since chip events arrive between subscribe and resolve).
  const inFlightChipsRef = useRef<Chip[]>([]);
  // Synchronous lock — setLoading(true) only commits next render, so two
  // fast Enter presses can both see loading=false and fire the agent
  // twice. A ref written synchronously closes that window. Mirrors the
  // useConversationEngine isProcessingRef pattern.
  const isProcessingRef = useRef(false);
  // Mirror of messages so the latest list is readable synchronously
  // from inside send() without depending on stale closure values.
  const messagesRef = useRef<AssistantMsg[]>([]);
  messagesRef.current = messages;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const greeting = useMemo(() => t("assistant.greeting"), [t]);

  // Sync the legacy voice config to the app language. Post-redesign this no
  // longer SELECTS the reply language anywhere: STT runs through auto-detecting
  // Gemini Live (legacy browser STT is debug-only), and TTS picks its voice
  // from the reply text's own script (detectTtsLang). The only thing
  // config.outputLang still does is act as the TTS fallback for Latin/unknown
  // text and disambiguate Devanagari (Hindi vs Marathi) — so keeping it in
  // sync with the app language is still correct, just no longer load-bearing.
  useEffect(() => {
    setLanguages(language);
  }, [language, setLanguages]);

  // Seed with the greeting TEXT on first open — but DO NOT speak it.
  //
  // Phase 3 design rule: Sathi never speaks first in the widget. The user
  // chose to open Sathi; they don't need a TTS welcome announcing what
  // they just clicked. The text greeting stays so the chat panel isn't
  // empty, but mic stays open and the model says nothing until the user
  // does. (Onboarding has its own opener — separate flow, separate hook.)
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ id: "greet", role: "assistant", content: greeting }]);
    }
  }, [open, messages.length, greeting]);

  // Live voice starts OFF when the widget opens. The user explicitly taps
  // the mic icon to enable it. This is the opposite of the prior auto-start
  // behavior — auto-start surprised users by recording before they expected
  // it, and made it impossible to "use Sathi without voice" without first
  // hearing it speak. With the toggle:
  //   - Mic off (default) = silent text-only assistant
  //   - Mic on = voice in + voice out via Gemini Live
  // Stopping the call cuts the WebSocket which immediately ends any
  // in-flight TTS, so an unwanted spoken response can be killed mid-
  // sentence by tapping the mic icon to mute.

  // Stop Live when the widget closes — don't keep an open WS + hot mic
  // running in the background.
  useEffect(() => {
    if (!open && liveVoice.state !== "idle") {
      liveVoice.stop();
    }
  }, [open, liveVoice]);

  // If the user ALREADY granted the browser geolocation permission, resolve
  // their real location once when the chat opens so "salons near me" works.
  // This never triggers the permission prompt — it only reads an existing
  // grant; without one the agent asks the user to name an area or enable
  // location access instead (prompt rule server-side).
  useEffect(() => {
    if (!open || !userLoc.isDefault) return;
    let cancelled = false;
    navigator.permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (!cancelled && status.state === "granted") requestLocation();
      })
      .catch(() => { /* Permissions API unavailable — stay on the default. */ });
    return () => { cancelled = true; };
  }, [open, userLoc.isDefault, requestLocation]);

  // Auto-scroll on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Appends a system-style message to the chat (used to surface booking
  // success/failure so the next LLM turn can see what happened).
  const pushSystemNote = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, role: "system", content: text },
    ]);
  }, []);

  /** When the agent emits open_listing / start_booking without a
   *  listingType (or only the legacy `category`), walk back through the
   *  chat history's cached listing-card strips and look up the type by id.
   *  Defaults to "stay" so the legacy route stays the safe fallback for
   *  pre-tool-loop conversations that never rendered cards. */
  const resolveListingTypeFromHistory = useCallback((id: string, hint?: unknown): string => {
    const fromHint = typeof hint === "string" ? hint.toLowerCase() : "";
    if (fromHint === "stay" || fromHint === "service" || fromHint === "transport") return fromHint;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const hits = messages[i]?.listingHits;
      if (!Array.isArray(hits)) continue;
      const hit = hits.find((h) => h.id === id);
      if (hit?.type) {
        const t = String(hit.type).toLowerCase();
        if (t === "stay" || t === "service" || t === "transport") return t;
      }
    }
    return "stay";
  }, [messages]);

  const runAction = useCallback(async (action?: UserAssistantAction) => {
    if (!action || action.type === "none") return;
    const p = action.params || {};
    switch (action.type) {
      case "navigate":
        if (typeof p.path === "string") navigate(p.path);
        setOpen(false);
        return;
      case "auth_required": {
        // Surfaced when a write tool refuses because the user isn't signed in.
        // The text bubble already carries the model's "you need to sign in"
        // line; this action handles the actual redirect with a return URL.
        const redirect = encodeURIComponent(location.pathname + location.search);
        navigate(`/login?redirect=${redirect}`);
        setOpen(false);
        return;
      }
      case "search": {
        const category = (p.category as string) || "stay";
        // First try to filter the page IN PLACE (chat stays open, grid
        // updates behind the non-modal panel). Falls back to navigation only
        // if the matching marketplace page isn't currently mounted.
        const num = (v: unknown) => (v == null || v === "" || isNaN(Number(v)) ? undefined : Number(v));
        const handled = marketplaceAgentBus.emit({
          type: "apply_filters",
          category: category as ApplyFiltersIntent["category"],
          q: (p.query || p.location || p.city) ? String(p.query || p.location || p.city) : undefined,
          maxPrice: num(p.maxPrice),
          minRating: num(p.minRating),
        });
        if (handled) return; // acted on-page; keep the conversation open
        const base = category === "service" ? "/services" : category === "transport" ? "/transport" : "/explore";
        const qs = new URLSearchParams();
        if (p.query) qs.set("q", String(p.query));
        if (p.location) qs.set("location", String(p.location));
        if (p.city) qs.set("city", String(p.city));
        if (p.maxPrice) qs.set("maxPrice", String(p.maxPrice));
        if (p.minRating) qs.set("minRating", String(p.minRating));
        navigate(qs.toString() ? `${base}?${qs}` : base);
        // Desktop: the sheet is a side panel — keep the conversation open so
        // the user can keep refining. Narrow viewports: the sheet covers the
        // whole page, so close it to reveal the filtered results.
        if (window.innerWidth < 640) setOpen(false);
        return;
      }
      case "apply_filters": {
        const category = (p.category as string) || "stay";
        const f = (p.filters || {}) as Record<string, unknown>;
        const num = (v: unknown) => (v == null || v === "" || isNaN(Number(v)) ? undefined : Number(v));
        const types = typeof f.type === "string"
          ? [f.type]
          : Array.isArray(f.categories)
            ? (f.categories as unknown[]).map(String)
            : undefined;
        // Try in-place first — filter the page the user is looking at without
        // navigating away or closing the chat.
        const subcategories = Array.isArray(f.subcategories)
          ? (f.subcategories as unknown[]).map(String)
          : undefined;
        const handled = marketplaceAgentBus.emit({
          type: "apply_filters",
          category: category as ApplyFiltersIntent["category"],
          q: f.q || f.city ? String(f.q || f.city) : undefined,
          maxPrice: num(f.maxPrice),
          minRating: num(f.minRating),
          types,
          serviceMode: typeof f.serviceMode === "string"
            ? (f.serviceMode as ApplyFiltersIntent["serviceMode"]) : undefined,
          transportMode: typeof f.transportMode === "string"
            ? (f.transportMode as ApplyFiltersIntent["transportMode"]) : undefined,
          subcategories,
        });
        if (handled) return;
        // Fallback: deep-link to a filtered page. State lives in the URL so
        // back-navigation restores it (ClientRedesign reads these on arrival).
        const base = category === "service" ? "/services" : category === "transport" ? "/transport" : "/explore";
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(f)) {
          if (v === undefined || v === null || v === "") continue;
          qs.set(k, String(v));
        }
        navigate(qs.toString() ? `${base}?${qs}` : base);
        // Same rule as the search fallback: only close where the sheet
        // covers the page (narrow viewports); desktop keeps the chat open.
        if (window.innerWidth < 640) setOpen(false);
        return;
      }
      case "show_listing_cards": {
        // Attach an inline-cards strip to the most recent assistant message.
        // The user reviews them in chat; only an explicit "open it" / Open
        // button click navigates to the detail page. Filters from the same
        // search are carried as query params so "back" restores the
        // filtered explore view, not a fresh feed.
        const hits = Array.isArray(p.hits)
          ? (p.hits as InlineListingHit[]).filter((h) => h && h.id && h.title)
          : [];
        if (!hits.length) return;
        const filterQs = new URLSearchParams();
        for (const [k, v] of Object.entries((p.filters as Record<string, unknown>) || {})) {
          if (v === undefined || v === null || v === "") continue;
          filterQs.set(k, String(v));
        }
        const fromSuffix = filterQs.toString() ? `?from=${encodeURIComponent(filterQs.toString())}` : "";
        // Tag each hit with the `from` suffix so Open/Book preserve filters.
        const annotated = hits.map((h) => ({ ...h, _from: fromSuffix } as InlineListingHit & { _from: string }));
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].listingHits) {
              next[i] = { ...next[i], listingHits: annotated };
              return next;
            }
          }
          next.push({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: "",
            listingHits: annotated,
          });
          return next;
        });
        return;
      }
      case "open_listing": {
        // Route by listing category so service/transport detail pages
        // open correctly when the user picked self-book. Defaults to
        // /stay/:id for stays and any unknown/missing type.
        //
        // Fallback: if the agent forgot to attach listingType, look it up
        // from the most recent search_listings result in this conversation
        // (we cache the hits on each assistant message). This is how
        // "open it" actually finds /service/<id> instead of dead-ending
        // on /stay/<service-id> when the user just self-booked a salon.
        if (p.listingId) {
          const cat = resolveListingTypeFromHistory(String(p.listingId), p.listingType || p.category);
          const base = cat === "service" ? "/service" : cat === "transport" ? "/transport" : "/stay";
          navigate(`${base}/${p.listingId}`);
        } else {
          // Agent emitted open_listing without an id. Surface a polite
          // recovery note so the user sees something happened, instead of
          // the silent "Cool — opening it now" with no navigation.
          pushSystemNote("I lost track of which listing you wanted to open. Tell me the name and I'll pull it up again.");
        }
        setOpen(false);
        return;
      }
      case "highlight_listing": {
        // Try to point at the card on the page the user is already viewing —
        // scroll it into view + flash it, keeping the chat open. If the card
        // isn't on screen (different category page, or beyond the loaded
        // grid), fall back to opening its detail page like open_listing.
        if (p.listingId && highlightMarketplaceCard(String(p.listingId))) {
          return; // highlighted in place; stay in the conversation
        }
        if (p.listingId) {
          const cat = resolveListingTypeFromHistory(String(p.listingId), p.listingType || p.category);
          const base = cat === "service" ? "/service" : cat === "transport" ? "/transport" : "/stay";
          navigate(`${base}/${p.listingId}`);
          setOpen(false);
        } else {
          pushSystemNote("I lost track of which listing you meant — tell me the name and I'll pull it up.");
        }
        return;
      }
      case "start_booking": {
        if (p.listingId) {
          const cat = resolveListingTypeFromHistory(String(p.listingId), p.listingType || p.category);
          const base = cat === "service" ? "/service" : cat === "transport" ? "/transport" : "/stay";
          navigate(`${base}/${p.listingId}?book=1`);
        }
        setOpen(false);
        return;
      }
      case "prepare_booking": {
        // LEGACY path (non-tool-loop): the agent emitted prepare_booking
        // without calling the tool, so the frontend has to create the hold
        // itself. This is the original behaviour and stays for ASSISTANT_TOOL_LOOP=0.
        if (!p.listingId || !p.scheduledDate) {
          pushSystemNote("I tried to prepare a booking but was missing details. Ask me again with a specific listing + date.");
          return;
        }
        const res = await getUserAssistantService().prepareBooking({
          listingId: String(p.listingId),
          scheduledDate: String(p.scheduledDate),
          checkOutDate: p.checkOutDate ? String(p.checkOutDate) : undefined,
          startTime: p.startTime ? String(p.startTime) : undefined,
          endTime: p.endTime ? String(p.endTime) : undefined,
          notes: p.notes ? String(p.notes) : undefined,
        });
        if (!res.success || !res.data) {
          pushSystemNote(`Couldn't lock that slot: ${res.error || "try another listing or date"}.`);
          return;
        }
        // Attach the card to the most recent assistant message, or spawn a
        // new one if none exists yet.
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].booking) {
              next[i] = { ...next[i], booking: res.data };
              return next;
            }
          }
          next.push({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: `Locked in ${res.data.listing.name} — confirm below to pay.`,
            booking: res.data,
          });
          return next;
        });
        return;
      }
      case "prepare_booking_done": {
        // Phase 2 path: the server-side agent loop already called the
        // prepare_booking tool, so `params` IS the PrepareBookingResult.
        // No second backend round-trip — just attach to the latest reply.
        const booking = p as unknown as PrepareBookingResult;
        if (!booking?.bookingId || !booking?.orderId) {
          pushSystemNote("Got a booking confirmation but the data looked incomplete. Try asking again.");
          return;
        }
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].booking) {
              next[i] = { ...next[i], booking };
              return next;
            }
          }
          next.push({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: `Locked in ${booking.listing.name} — confirm below to pay.`,
            booking,
          });
          return next;
        });
        return;
      }
      case "confirm_cancel_booking": {
        // Agent already called cancel_booking_preview and surfaced the
        // refund/policy summary in its text reply. Attach a confirm card
        // so the user has an explicit gate before we PATCH bookings.
        if (!p.bookingId) {
          pushSystemNote("Couldn't tell which booking to cancel — name it again?");
          return;
        }
        const cancelConfirm: CancelConfirmation = {
          bookingId: String(p.bookingId),
          summary: typeof p.summary === "string" ? p.summary : undefined,
        };
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].cancelConfirm) {
              next[i] = { ...next[i], cancelConfirm };
              return next;
            }
          }
          next.push({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: "Confirm cancellation below.",
            cancelConfirm,
          });
          return next;
        });
        return;
      }
      case "confirm_message_host": {
        if (!p.listingId || !p.message || !p.hostUserId) {
          pushSystemNote("Couldn't put together that message — what did you want to say?");
          return;
        }
        const messageHostConfirm: MessageHostConfirmation = {
          listingId: String(p.listingId),
          hostUserId: String(p.hostUserId),
          message: String(p.message),
          hostName: typeof p.hostName === "string" ? p.hostName : undefined,
        };
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].messageHostConfirm) {
              next[i] = { ...next[i], messageHostConfirm };
              return next;
            }
          }
          next.push({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: "Review and send below.",
            messageHostConfirm,
          });
          return next;
        });
        return;
      }
      case "show_bookings": {
        // Attach the user's bookings to the latest assistant message so they
        // render as an inline list (BookingsListInline) — same attach pattern
        // as show_listing_cards.
        const rows = Array.isArray(p.bookings)
          ? (p.bookings as InlineBooking[]).filter((b) => b && b.id)
          : [];
        if (!rows.length) return;
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].bookings) {
              next[i] = { ...next[i], bookings: rows };
              return next;
            }
          }
          next.push({ id: `a-${Date.now()}`, role: "assistant", content: "", bookings: rows });
          return next;
        });
        return;
      }
      case "show_insights": {
        const insights = p.insights as BookingInsights | undefined;
        if (!insights || insights.empty) return;
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].insights) {
              next[i] = { ...next[i], insights };
              return next;
            }
          }
          next.push({ id: `a-${Date.now()}`, role: "assistant", content: "", insights });
          return next;
        });
        return;
      }
      case "wishlist_updated": {
        // The toggle_wishlist tool already persisted this server-side. Sync
        // SavedContext so the heart on cards/detail pages and the dashboard
        // Saved tab reflect it immediately — no second backend write.
        if (p.listingId) {
          const type = p.listingType === "service" ? "service" : p.listingType === "transport" ? "transport" : "stay";
          applyServerSave(type, String(p.listingId), p.action !== "remove");
        }
        return;
      }
      case "view_bookings":
        navigate(user?.role === "host" ? "/dashboard/host" : "/bookings");
        setOpen(false);
        return;
      case "become_host":
        navigate("/become-host");
        setOpen(false);
        return;
    }
  }, [navigate, user?.role, pushSystemNote, resolveListingTypeFromHistory, applyServerSave]);

  const send = useCallback(async (text: string, opts?: { fromVoice?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const liveCanTakeText = liveEnabled && (liveVoice.state === "listening" || liveVoice.state === "speaking");
    if (liveCanTakeText) {
      setInput("");
      const delivered = liveVoice.sendText(trimmed);
      if (delivered) {
        // A typed turn counts as "the user spoke" for the voice-bubble
        // regeneration logic — the model's reply is a new answer, not a
        // re-generation of the previous one.
        userSpokeSinceTurnRef.current = true;
        setMessages((prev) => [
          ...prev,
          { id: `u-${Date.now()}`, role: "user", content: trimmed },
        ]);
        return;
      }
    }
    // Synchronous re-entrancy guard. setLoading(true) doesn't commit until
    // the next render, so two fast Enter presses (or voice+text races)
    // both pass the loading check. A ref written synchronously closes
    // that window — first call wins, the second returns immediately.
    if (isProcessingRef.current || loading) return;
    isProcessingRef.current = true;
    // Dedup consecutive identical user sends (voice + text typed the
    // same thing, or accidental double-Enter inside the same render).
    const latest = messagesRef.current[messagesRef.current.length - 1];
    if (latest && latest.role === "user" && latest.content.trim() === trimmed) {
      isProcessingRef.current = false;
      return;
    }
    setInput("");
    const nextMsgs: AssistantMsg[] = [
      ...messagesRef.current,
      { id: `u-${Date.now()}`, role: "user", content: trimmed },
    ];
    setMessages(nextMsgs);
    // Signed-out users can open Sathi and see the greeting, but the assistant
    // backend requires an auth token. Short-circuit with a canned nudge that
    // points them to sign in instead of hitting a 401.
    if (!isAuthenticated) {
      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: t("assistant.signedOutMsg"),
        suggestions: [t("assistant.chipSignIn"), t("assistant.chipSignUp"), t("assistant.chipKeepBrowsing")],
      }]);
      isProcessingRef.current = false;
      return;
    }
    setLoading(true);

    // Phase 5: mint a requestId BEFORE firing the request and subscribe
    // to the chip channel. Server fires tool_start/tool_done/tool_error
    // events on `user:<uid>:assistant:<requestId>:tools` while the loop runs; we
    // route them into a placeholder assistant bubble.
    const requestId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyId = `a-${Date.now()}`;
    const chipKeyByName = new Map<string, string>(); // name → chip.id (so done updates the right one)

    // Chips render in a "loose" thinking row above the typing indicator
    // while the loop runs; on response they fold into the final reply
    // bubble and inFlightChips clears. Cleaner than threading them
    // through a placeholder message.
    inFlightChipsRef.current = [];
    setInFlightChips([]);

    const realtime = getRealtimeProvider();
    // Channel is user-scoped (SEC-005): the ws server only allows a client
    // to subscribe to its own `user:<uid>:...` channels, so the chip stream
    // can't be watched cross-user via a guessed requestId.
    const sub = realtime.subscribeToChannel(
      `user:${user?.id}:assistant:${requestId}:tools`,
      (event: ToolChannelEvent | null) => {
        if (!event || typeof event !== "object") return;
        setInFlightChips((prev) => {
          const chips = [...prev];
          // Keep ref synced for the post-await read in the success path.
          // Mutation timing is fine: ref is updated when this setState
          // callback runs, before React commits.
          // (We assign at the end of the function via the return value.)
          if (event.type === "tool_start") {
            const id = `chip-${event.name}-${Date.now()}-${chips.length}`;
            chipKeyByName.set(event.name, id);
            chips.push({
              id,
              toolName: event.name,
              status: "pending",
              pendingLabel: pendingLabelFor(event.name, event.argsSummary),
            });
          } else if (event.type === "tool_done") {
            const id = chipKeyByName.get(event.name);
            if (id) {
              const idx = chips.findIndex((c) => c.id === id);
              if (idx !== -1) {
                chips[idx] = { ...chips[idx], status: "done", doneLabel: event.summary };
              }
            }
          } else if (event.type === "tool_error") {
            const id = chipKeyByName.get(event.name);
            if (id) {
              const idx = chips.findIndex((c) => c.id === id);
              if (idx !== -1) {
                chips[idx] = { ...chips[idx], status: "error", errorMessage: event.message };
              }
            }
          }
          inFlightChipsRef.current = chips;
          return chips;
        });
      },
    );

    try {
      const result = await getUserAssistantService().respond({
        // System messages (booking status notes we injected) are surfaced to
        // the LLM as user-role annotations — the schema only accepts
        // user/assistant/system and we want the model to see the note, not
        // treat it as authoritative instruction.
        messages: nextMsgs.map((m) => ({
          role: m.role === "system" ? ("user" as const) : m.role,
          content: m.role === "system" ? `[system] ${m.content}` : m.content,
        })),
        displayLang: language,
        // Page-aware context — the assistant uses this to switch personas
        // (trip planner on /, booking helper on /stay/*, onboarding helper
        // on /onboarding). The listingType derives from the URL params so
        // we don't need to know the form state directly.
        context: (() => {
          const path = location.pathname;
          const search = location.search;
          const typeParam = new URLSearchParams(search).get("type");
          let surface: "discovery" | "onboarding" | "booking-details" | "dashboard" | "other" = "other";
          if (path === "/" || path.startsWith("/explore") || path.startsWith("/services") || path.startsWith("/transport")) {
            surface = "discovery";
          } else if (path.startsWith("/onboarding") || path.startsWith("/become-")) {
            surface = "onboarding";
          } else if (path.startsWith("/stay/") || path.startsWith("/service/") || path.startsWith("/transport/")) {
            surface = "booking-details";
          } else if (path.startsWith("/dashboard/")) {
            surface = "dashboard";
          }
          return {
            path,
            surface,
            listingType:
              typeParam === "host" ? "stay" :
              typeParam === "service" ? "service" :
              typeParam === "transport" ? "transport" : null,
            // Real device location only — never the Hampi placeholder. Lets
            // the agent answer "salons near me" with the user's actual area;
            // when absent the prompt tells it to ask instead of guessing.
            location: userLoc.isDefault ? undefined : {
              lat: userLoc.lat,
              lng: userLoc.lng,
              city: userLoc.name && userLoc.name !== "Your location" ? userLoc.name : undefined,
              state: userLoc.state || undefined,
            },
          };
        })(),
        requestId,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || "Assistant unavailable");
      }
      // Append the assistant reply, folding in whichever chips arrived
      // during the loop. If realtime didn't deliver any (e.g. websocket
      // off, chips flag disabled on server), synthesise done-chips from
      // the toolCalls telemetry array as a fallback so the user still
      // sees what the agent did.
      const liveChips = inFlightChipsRef.current;
      const finalChips: Chip[] = liveChips.length > 0
        ? liveChips
        : (result.data.toolCalls ?? [])
            .filter((tc) => isUserVisibleClientChip(tc.name) && tc.durationMs >= 300)
            .map<Chip>((tc, i) => ({
              id: `chip-fb-${tc.name}-${i}`,
              toolName: tc.name,
              status: tc.ok ? "done" : "error",
              pendingLabel: pendingLabelFor(tc.name, ""),
              doneLabel: tc.summary,
            }));
      setMessages((prev) => {
        const replyText = (result.data!.message || "…").trim();
        // Suppress consecutive identical assistant turns (re-firing
        // turn_complete, duplicate text/voice replies).
        const lastA = prev[prev.length - 1];
        if (lastA && lastA.role === "assistant" && lastA.content.trim() === replyText) {
          return prev;
        }
        return [
          ...prev,
          {
            id: replyId,
            role: "assistant",
            content: result.data!.message || "…",
            suggestions: result.data!.suggestions,
            chips: finalChips.length > 0 ? finalChips : undefined,
            requestId,
          },
        ];
      });
      inFlightChipsRef.current = [];
      setInFlightChips([]);
      // Only speak the reply when the user is actually using voice this
      // turn — STT just transcribed them, OR Gemini Live is active. When
      // the user is typing into the chat input, TTS firing is unwanted
      // (the mic icon is off → the AI shouldn't speak). The opts.fromVoice
      // flag is set by the transcript handler; manual sends leave it
      // undefined.
      const voiceActive = opts?.fromVoice
        || voiceState === "listening"
        || liveVoice.state === "connected"
        || liveVoice.state === "speaking"
        || liveVoice.state === "listening";
      if (supportsTTS && voiceActive && !isMuted) speak(stripChatMarkdown(result.data.message || ""));
      // runAction is async for prepare_booking; fire-and-forget is fine here.
      void runAction(result.data.action);
    } catch (err: unknown) {
      // Surface an error reply.
      const message = err instanceof Error ? err.message : "";
      setMessages((prev) => [
        ...prev,
        {
          id: replyId,
          role: "assistant",
          content: message.includes("401") ? t("assistant.errAuth") : t("assistant.errGeneric"),
        },
      ]);
      inFlightChipsRef.current = [];
      setInFlightChips([]);
    } finally {
      try { sub.unsubscribe(); } catch { /* noop */ }
      setLoading(false);
      isProcessingRef.current = false;
    }
  }, [loading, language, location.pathname, supportsTTS, speak, runAction, isAuthenticated, user?.id, navigate, t, liveEnabled, liveVoice, voiceState, isMuted, userLoc]);

  // Wire voice → send. fromVoice tells send() this turn came through the
  // mic so the reply should be spoken back; manual text input leaves the
  // flag unset and stays silent.
  useEffect(() => {
    setOnTranscript((text) => {
      void send(text, { fromVoice: true });
    });
  }, [setOnTranscript, send]);

  // Note: we intentionally render for signed-out users too. Sathi greets them,
  // and `send()` short-circuits with a sign-in nudge rather than calling the
  // backend — so they get the assistant surface without hitting a 401.
  return (
    <>
      {/* Single canonical Ista AI floating button. The gradient matches the
          IstaSeva redesign palette (plum → rose → tan) used by primary CTAs
          in src/redesign/MarketplaceControls.tsx, so the button reads as
          native chrome rather than a separate product. */}
      <Button
        onClick={() => {
          if (!isAuthenticated) { setAuthGateOpen(true); return; }
          setOpen(true);
        }}
        aria-label={t("assistant.openLabel")}
        style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
        className="fixed bottom-5 right-5 z-50 h-12 pl-3 pr-4 rounded-full shadow-[0_14px_30px_rgba(58,50,71,0.28)] hover:shadow-[0_18px_36px_rgba(58,50,71,0.35)] hover:opacity-95 text-white gap-2 font-extrabold transition-all"
      >
        <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-white/15">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="text-sm tracking-tight">Ista AI</span>
      </Button>

      {/*
        modal={false} — Radix Dialog's default modal behavior applies
        `pointer-events: none` to every sibling of the dialog. When the
        assistant launches Razorpay's checkout iframe (which renders into
        document.body, OUTSIDE this Sheet's portal), the iframe inherits the
        no-pointer-events state and its X/close button stops responding
        until the Sheet is dismissed. Making the Sheet non-modal keeps it
        visible while letting the Razorpay overlay take pointer events
        naturally. We lose Radix's outside-click-to-close, but the panel
        has an explicit X button already.
      */}
      <Sheet open={open} onOpenChange={setOpen} modal={false}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md flex flex-col p-0 gap-0 h-[100dvh] sm:h-screen"
        >
          <SheetHeader className="border-b p-4 flex-row items-center justify-between space-y-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t("assistant.title")}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t("assistant.sheetDesc")}
            </SheetDescription>
          </SheetHeader>

          {/* Native scroll container. Radix ScrollArea was breaking layout
              here: its viewport wraps content in a display:table div that
              sizes to its widest child, so wide cards (BookingConfirmCard)
              forced the bubble's `max-w-[85%]` to resolve against an
              inflated width and bubbles spilled off the right edge of
              the chat panel. A regular overflow-y-auto div uses normal
              block flow, so 100% width and max-w-% behave as expected.
              The scrollRef.scrollTo("scrollHeight") usage on line 343
              works the same on this element. */}
          <div
            className="flex-1 px-4 py-3 overflow-y-auto overflow-x-hidden min-w-0"
            ref={scrollRef}
          >
            <div className="space-y-3">
              {messages.map((m) => {
                if (m.role === "system") {
                  return (
                    <div key={m.id} className="text-center text-[11px] text-muted-foreground italic">
                      {m.content}
                    </div>
                  );
                }
                const hasCards = !!(m.booking || m.cancelConfirm || m.messageHostConfirm || (m.listingHits && m.listingHits.length > 0) || (m.bookings && m.bookings.length > 0) || m.insights);
                const hasBubbleContent = !!m.content || !!(m.chips && m.chips.length > 0);
                return (
                // w-full + min-w-0: without an explicit width the flex-col
                // wrapper sized to its widest child (the card), which made
                // the bubble's `max-w-[85%]` resolve to 85% of THAT
                // intrinsic width — i.e. essentially unbounded — and
                // bubbles spilled past the chat panel edge. min-w-0 lets
                // children shrink past their content size so long
                // unbreakable words wrap instead of forcing horizontal
                // overflow.
                <div key={m.id} className={cn("flex flex-col gap-2 w-full min-w-0", m.role === "user" ? "items-end" : "items-start")}>
                  {/* Text bubble — caps at 85% of the chat width, breaks
                      long words instead of overflowing. Skipped entirely
                      when this message is card-only (e.g. listingHits
                      with empty content) so we don't render a blank
                      rounded box above the cards. */}
                  {hasBubbleContent && (
                    <div
                      className={cn(
                        "max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
                        m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      )}
                    >
                      {m.chips && m.chips.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1">
                          {m.chips.map((chip) => (
                            <ToolCallChip key={chip.id} chip={chip} />
                          ))}
                        </div>
                      )}
                      {m.role === "assistant" ? <ChatMarkdown text={m.content} /> : m.content}
                    </div>
                  )}
                  {/* Cards render as SIBLINGS of the bubble at the full
                      width of the message wrapper (the wrapper is
                      already w-full, so this just inherits the chat
                      panel's content width minus its padding). No
                      double-border / cramped-padding from being nested
                      inside the rounded bubble. */}
                  {hasCards && (
                    <div className="w-full min-w-0">
                      {m.booking && (
                        <BookingConfirmCard
                          booking={m.booking}
                          userEmail={user?.email}
                          userPhone={user?.phone}
                          userName={user?.name}
                          onSuccess={(paymentId) => {
                            refreshBookingCaches();
                            pushSystemNote(`Payment successful (${paymentId ? paymentId.replace(/-/g, "").slice(0, 16).toUpperCase() : "ok"}). Booking confirmed.`);
                          }}
                          onFailure={(msg) => pushSystemNote(msg)}
                        />
                      )}
                      {m.cancelConfirm && (
                        <CancelBookingCard
                          bookingId={m.cancelConfirm.bookingId}
                          summary={m.cancelConfirm.summary}
                          onResolved={(note) => {
                            // Fires for kept/failed too — invalidation is
                            // harmless there and this is the only hook we get.
                            refreshBookingCaches();
                            pushSystemNote(note);
                          }}
                        />
                      )}
                      {m.messageHostConfirm && (
                        <MessageHostCard
                          listingId={m.messageHostConfirm.listingId}
                          hostUserId={m.messageHostConfirm.hostUserId}
                          initialMessage={m.messageHostConfirm.message}
                          hostName={m.messageHostConfirm.hostName}
                          onResolved={(note) => pushSystemNote(note)}
                        />
                      )}
                      {m.listingHits && m.listingHits.length > 0 && (
                      <ListingCardsInline
                        hits={m.listingHits}
                        onOpen={(hit) => {
                          // Preserve search filters in a `from` query param so
                          // the back button restores the filtered list view.
                          const fromSuffix = (hit as InlineListingHit & { _from?: string })._from ?? "";
                          const base = hit.type === "service"
                            ? `/service/${hit.id}`
                            : hit.type === "transport"
                              ? `/transport/${hit.id}`
                              : `/stay/${hit.id}`;
                          navigate(`${base}${fromSuffix}`);
                          setOpen(false);
                        }}
                        onBook={(hit) => {
                          // Stays + services + transport all share the
                          // ?book=1 query-param convention on the detail page.
                          const fromSuffix = (hit as InlineListingHit & { _from?: string })._from ?? "";
                          const base = hit.type === "service"
                            ? `/service/${hit.id}`
                            : hit.type === "transport"
                              ? `/transport/${hit.id}`
                              : `/stay/${hit.id}`;
                          const sep = fromSuffix ? "&" : "?";
                          navigate(`${base}${fromSuffix}${sep}book=1`);
                          setOpen(false);
                        }}
                      />
                      )}
                      {m.bookings && m.bookings.length > 0 && (
                        <BookingsListInline
                          bookings={m.bookings}
                          onManage={() => {
                            navigate(user?.role === "host" ? "/dashboard/host" : "/bookings");
                            setOpen(false);
                          }}
                        />
                      )}
                      {m.insights && (
                        <InsightsStripInline
                          insights={m.insights}
                          onViewAll={() => {
                            navigate(user?.role === "host" ? "/dashboard/host" : "/bookings");
                            setOpen(false);
                          }}
                        />
                      )}
                    </div>
                  )}
                  {m.suggestions && m.suggestions.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {m.suggestions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            // Signed-out chips short-circuit to the auth page so the
                            // user isn't stuck looping on the canned nudge.
                            if (!isAuthenticated && s === t("assistant.chipSignIn")) { setOpen(false); navigate("/login"); return; }
                            if (!isAuthenticated && s === t("assistant.chipSignUp")) { setOpen(false); navigate("/signup"); return; }
                            if (!isAuthenticated && s === t("assistant.chipKeepBrowsing")) { setOpen(false); return; }
                            void send(s);
                          }}
                          className="text-xs rounded-full border px-2 py-1 hover:bg-background"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
              {loading && inFlightChips.length > 0 && (
                <div className="flex justify-start">
                  <div className="flex flex-wrap gap-1">
                    {inFlightChips.map((chip) => (
                      <ToolCallChip key={chip.id} chip={chip} />
                    ))}
                  </div>
                </div>
              )}
              {loading && (
                <div className="flex justify-start">
                  <div
                    className="bg-muted text-muted-foreground flex items-center gap-1 rounded-2xl px-3 py-3"
                    role="status"
                    aria-label={t("assistant.thinking", { defaultValue: "Ista AI is thinking…" })}
                  >
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-current animate-typing-dot motion-reduce:animate-none"
                        style={{ animationDelay: `${i * 160}ms` }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {interimTranscript && (
                <div className="text-xs text-muted-foreground italic">{interimTranscript}</div>
              )}

              {/* Quick-start chips — shown only on the empty/first-open state so
                  the drawer doesn't feel like a blank white panel. Each chip
                  sends a real message through send() so the customer assistant
                  backend handles it (search/book/navigate/help), not a fake
                  prototype suggestion list. */}
              {!loading && messages.length <= 1 && (
                <div className="pt-3 space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Try asking
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      "Find stays nearby",
                      "Book a service",
                      "Plan a trip",
                      "Find transport",
                      "Help me with this page",
                    ].map((label) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => void send(label)}
                        className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-colors"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-3 space-y-2">
            {liveEnabled && (
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Radio className={cn(
                    "h-3.5 w-3.5",
                    liveVoice.state === "listening" && "text-green-600 animate-pulse",
                    liveVoice.state === "speaking" && "text-orange-500 animate-pulse",
                    liveVoice.state === "permission_denied" && "text-amber-600",
                    liveVoice.state === "error" && "text-red-500",
                  )} />
                  <span className="font-medium">{t("assistant.liveLabel")}</span>
                  <span className="text-muted-foreground">
                    {liveVoice.state === "idle" && t("assistant.liveIdle")}
                    {liveVoice.state === "connecting" && t("assistant.liveConnecting")}
                    {liveVoice.state === "listening" && t("assistant.liveListening")}
                    {liveVoice.state === "speaking" && t("assistant.liveSpeaking")}
                    {liveVoice.state === "permission_denied" && t("assistant.micBlocked")}
                    {liveVoice.state === "error" && (liveVoice.lastError || t("assistant.liveError"))}
                  </span>
                </div>
                {/*
                  Mic toggle. Single circular button that flips between
                  "tap to start" (Mic icon) and "tap to mute" (MicOff icon
                  with a clear visual hint). Replaces the prior 3-way
                  Retry / Start / End call cluster — one control, one
                  affordance, same outcome. Tapping it while the AI is
                  mid-sentence stops it instantly because liveVoice.stop()
                  closes the WS and the AudioContext.
                  permission_denied / error states reuse the off-state
                  appearance — tap retries.
                */}
                {(() => {
                  const isLive = liveVoice.state === "connecting"
                    || liveVoice.state === "listening"
                    || liveVoice.state === "speaking";
                  return (
                    <Button
                      type="button"
                      size="icon"
                      variant={isLive ? "default" : "outline"}
                      onClick={() => (isLive ? liveVoice.stop() : void liveVoice.start())}
                      aria-label={isLive ? t("assistant.endCall") : t("assistant.start")}
                      aria-pressed={isLive}
                      className={cn(
                        "h-8 w-8 rounded-full shrink-0",
                        isLive && "bg-rose-500 hover:bg-rose-600 text-white border-rose-500",
                      )}
                    >
                      {isLive ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                    </Button>
                  );
                })()}
              </div>
            )}
            <div className="flex items-center gap-2">
              {/* Legacy browser-STT controls. When Live voice is on (the
                  default), these are redundant AND actively conflict —
                  both paths fight for the mic and the speaker. The pill
                  above is the canonical voice surface in that mode.
                  Kept only for the localStorage.sathi_voice_live='debug-legacy'
                  troubleshooting sentinel. */}
              {!liveEnabled && (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant={voiceState === "listening" ? "default" : "outline"}
                    onClick={toggleListening}
                    disabled={!supportsSTT}
                    aria-label={t("assistant.micLabel")}
                    className="shrink-0"
                  >
                    {voiceState === "listening" ? <Mic className="h-4 w-4 animate-pulse" /> : <MicOff className="h-4 w-4" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => setIsMuted(!isMuted)}
                    aria-label={isMuted ? t("assistant.unmuteLabel") : t("assistant.muteLabel")}
                    className="shrink-0"
                  >
                    {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </Button>
                </>
              )}
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
                placeholder={t("assistant.placeholder")}
                disabled={loading}
                className="flex-1"
              />
              <Button
                type="button"
                size="icon"
                onClick={() => void send(input)}
                disabled={loading || !input.trim()}
                aria-label={t("assistant.sendLabel")}
                className="shrink-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            {/* Only show the "browser doesn't support voice" hint when we
                actually fall back to browser STT. Live voice works fine on
                Safari and edge-cases where browser STT doesn't, so this
                message would just confuse users in those situations. */}
            {!liveEnabled && !supportsSTT && (
              <p className="text-[11px] text-muted-foreground">
                {t("assistant.voiceUnsupported")}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={authGateOpen} onOpenChange={setAuthGateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("assistant.gateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("assistant.gateDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("assistant.gateCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setAuthGateOpen(false); navigate("/login"); }}>
              {t("assistant.gateSignIn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
