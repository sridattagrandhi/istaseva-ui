import { useState, useRef, useEffect, useCallback, useMemo, type ComponentProps } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Send, ArrowLeft, Bot, Globe, ChevronRight, MapPin, Shield, Upload, CheckCircle2, Clock, IdCard, Car, CreditCard, FileCheck, AlertCircle, FileText, Radio, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Language, useLanguage } from "@/contexts/LanguageContext";
import { useLocation as useGeoLocation } from "@/contexts/LocationContext";
import { useGeminiLiveVoice } from "@/hooks/useGeminiLiveVoice";
import { useConversationEngine, normalizeAgentPatch } from "@/hooks/useConversationEngine";
import ConversationPanel from "@/components/onboarding/ConversationPanel";
import ActionOverlay from "@/components/onboarding/ActionOverlay";
import OnboardingPreview from "@/components/onboarding/OnboardingPreview";
import OnboardingForm from "@/components/onboarding/OnboardingForm";
import LanguageSettings from "@/components/onboarding/LanguageSettings";
import { getVerificationService } from "@/domains";
import { getAccessToken } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clearOnboardingDraft } from "@/lib/onboarding-draft";
import {
  getOnboardingMissingFields,
  missingOnboardingLabel,
  type PendingOnboardingRoom,
} from "@/lib/onboarding-validation";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

/**
 * Onboarding page — unified Live voice agent for voice + form/typed engine
 * for keyboard input.
 *
 * Why two paths share state:
 *   - Voice path uses Gemini Live (mode='onboarding'). The server-side voice
 *     agent runs the same onboarding tools as the text agent and emits
 *     `profile_update` / `picker_action` / `submit_ready` events. We merge
 *     those into the same `profile` state the typed engine owns.
 *   - Typed path uses useConversationEngine (POST /api/onboarding-chat).
 *     It does NOT speak (per user spec: "If we type → it should type, not
 *     talk"). It just renders text into the chat panel.
 *
 * The user spec is explicit: "If we talk it should talk and transcribe.
 * If we type it should type not talk." This file is the wiring for that.
 */
const AIOnboarding = () => {
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { location: geoLoc, requestLocation, isLocating } = useGeoLocation();

  const initialMode: "ai" | "form" = searchParams.get("mode") === "form" ? "form" : "ai";

  const typeParam = searchParams.get("type");
  // Manual onboarding is now SPLIT per entry doorway — services and transport
  // are no longer bundled because that made the conditional form unwieldy
  // (and broke entirely once users started adding custom categories that
  // didn't match either group). One entry = one type.
  const allowedGroups: ("stay" | "transport" | "service")[] | undefined =
    typeParam === "service" ? ["service"]
      : typeParam === "transport" ? ["transport"]
        : typeParam === "host" ? ["stay"]
          : undefined;
  // Entry scope handed to the agent so it knows which doorway the user
  // walked through. Distinct from `allowedGroups` (which gates the form
  // dropdown) — the agent needs the SCOPE not the dropdown filter, and
  // it uses scope to redirect to the other portal when needed.
  const entryType: "host" | "service" | "transport" | "any" =
    typeParam === "host" ? "host" :
    typeParam === "service" ? "service" :
    typeParam === "transport" ? "transport" : "any";
  // Mirrors the form's draft scope so AI-mode publishes clear the right
  // saved draft (the form may have saved a "transport" draft that the
  // user then completed via voice).
  const draftType: import("@/lib/onboarding-draft").OnboardingDraftType =
    typeParam === "host" ? "stay"
      : typeParam === "service" ? "service"
        : typeParam === "transport" ? "transport"
          : "any";

  const [displayLang, setDisplayLang] = useState<Language>("en");
  const [spokenInputLang, setSpokenInputLang] = useState<Language>("en");
  const [showLangSettings, setShowLangSettings] = useState(false);
  const [input, setInput] = useState("");
  const [showKyc, setShowKyc] = useState(false);
  const [kycUploading, setKycUploading] = useState<string | null>(null);
  const [kycUploaded, setKycUploaded] = useState<Record<string, "pending" | "approved" | "rejected">>({});
  const [mode, setMode] = useState<"ai" | "form">(initialMode);
  const [showFormMissing, setShowFormMissing] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  // Phase 4: the manual form routes through a mandatory review before
  // create. When the user submits the form we stash the (already-validated)
  // submit payload here and show the preview; null = no review pending.
  type FormSubmitExtra = NonNullable<Parameters<ComponentProps<typeof OnboardingForm>["onSubmit"]>[0]>;
  const [formReview, setFormReview] = useState<FormSubmitExtra | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const kycFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const engine = useConversationEngine(displayLang, entryType);
  const {
    messages, profile, currentAction, isProcessing,
    isComplete, showPreview, isHost, isTransport, createdListingId, getProgress,
    handleInput, handleCategorySelect, handleLocationDetected,
    handleAvailabilitySelect, startConversation, confirmAndSubmit,
    setShowPreview, setCurrentAction, addMessage,
    setProfile,
  } = engine;

  const routeToMissingFields = useCallback((rooms?: PendingOnboardingRoom[]) => {
    const missing = getOnboardingMissingFields(profile, { pendingRooms: rooms, allowedGroups });
    if (missing.size === 0) return false;

    const labels = Array.from(missing).map(missingOnboardingLabel);
    const message = t("aiOnboarding.missingFieldsMessage", { defaultValue: "I still need these required details before creating your listing: {{labels}}. I've opened the form so you can finish them.", labels: labels.join(", ") });
    toast.error(t("aiOnboarding.pleaseComplete", { defaultValue: "Please complete: {{labels}}", labels: labels.join(", ") }));
    addMessage("assistant", message);
    setShowFormMissing(true);
    setShowPreview(false);
    setMode("form");
    return true;
  }, [addMessage, allowedGroups, profile, setShowPreview, t]);

  // Buffers used to assemble streaming Live transcripts into single chat
  // bubbles. The Live API emits chunks; we commit on `turn_complete`.
  const userBufferRef = useRef<string>("");
  const assistantBufferRef = useRef<string>("");
  const [interimTranscript, setInterimTranscript] = useState("");

  const liveCallbacks = useMemo(() => ({
    onUserTranscript: (chunk: string) => {
      userBufferRef.current += chunk;
      setInterimTranscript(userBufferRef.current);
    },
    onAssistantTranscript: (chunk: string) => {
      assistantBufferRef.current += chunk;
    },
    onTurnComplete: () => {
      const userText = userBufferRef.current.trim();
      const asstText = assistantBufferRef.current.trim();
      if (userText) addMessage("user", userText);
      if (asstText) addMessage("assistant", asstText);
      userBufferRef.current = "";
      assistantBufferRef.current = "";
      setInterimTranscript("");
    },
    onProfileUpdate: (patch: Record<string, unknown>) => {
      // Voice agent's extract_fields tool — merge directly into shared
      // profile. Goes through `normalizeAgentPatch` so packageOptions
      // (numeric in the agent schema, string in the form editor) round-
      // trip cleanly; everything else passes through unchanged.
      setProfile((prev) => ({ ...prev, ...(normalizeAgentPatch(patch) as Partial<typeof prev>) }));
    },
    onPickerAction: (action: string) => {
      // Voice agent's set_picker_action tool — show e.g. photo_upload chip.
      const allowed = [
        "category_select", "location_picker", "photo_upload",
        "price_input", "availability_select", "none",
      ] as const;
      if ((allowed as readonly string[]).includes(action)) {
        setCurrentAction(action as (typeof allowed)[number]);
      }
    },
    onSubmitReady: () => {
      // Voice agent's submit_listing tool fired with all required fields.
      // We open the preview rather than auto-confirming so the user gets
      // one final eyes-on review before we POST.
      if (routeToMissingFields()) return;
      setShowPreview(true);
    },
    onUiAction: (event: { action: string; params?: Record<string, unknown> }) => {
      // Generic UI hook (e.g. open a route) — not used by onboarding tools
      // today but reserved so onboarding can navigate later if needed.
      if (event.action === "navigate" && typeof event.params?.path === "string") {
        navigate(event.params.path as string);
      }
    },
  }), [addMessage, setProfile, setCurrentAction, setShowPreview, navigate, routeToMissingFields]);

  const live = useGeminiLiveVoice(liveCallbacks, { mode: "onboarding", entry: entryType, initialProfile: profile as unknown as Record<string, unknown> });

  // Keep the server-side voice agent's profile in sync with local state.
  // Triggered by manual-form edits (mode flip back to AI), AI-text turns
  // that extract fields, or the user toggling between AI/voice. Without
  // this, the voice agent re-asks fields the user already filled.
  useEffect(() => {
    if (live.state === "idle" || live.state === "connecting") return;
    try { live.syncProfile?.(profile as unknown as Record<string, unknown>); } catch { /* noop */ }
  }, [profile, live]);

  // Auto-start conversation on mount: greet via the typed engine (renders
  // an assistant bubble) and open the Live channel so the user can speak
  // back. The user can also type — both paths feed the same `profile`.
  const conversationStartedRef = useRef(false);
  useEffect(() => {
    if (conversationStartedRef.current) return;
    if (initialMode === "form") return;
    conversationStartedRef.current = true;
    startConversation();
    // Don't auto-start Live voice. The user explicitly taps the mic in the
    // voice pill below — opening AI onboarding shouldn't surprise them by
    // recording. The text conversation engine is already running; mic-on
    // upgrades to voice-in / voice-out via Gemini Live when the user
    // chooses, mic-off keeps it silent and text-only.
  }, [initialMode, startConversation]);

  const progress = getProgress();

  // Text-agent completion and voice-agent completion both eventually flip
  // `showPreview`. Treat that as a final client-side gate before the preview
  // can say the listing is ready to submit.
  useEffect(() => {
    if (!showPreview) return;
    routeToMissingFields();
  }, [showPreview, routeToMissingFields]);

  const handleSendText = () => {
    if (!input.trim() || isProcessing) return;
    const text = input.trim();
    setInput("");
    // If Live voice is active, typed turns go into that same Live session
    // so switching from speaking to typing doesn't split the conversation
    // across two separate agents with different memory.
    if (live.state === "listening" || live.state === "speaking") {
      try { live.syncProfile?.(profile as unknown as Record<string, unknown>); } catch { /* noop */ }
      if (live.sendText(text)) {
        addMessage("user", text);
        return;
      }
    }
    handleInput(text);
  };

  const handleLocationShare = () => {
    requestLocation();
    toast.info(t("aiOnboarding.detectingLocation", { defaultValue: "Detecting your location..." }));
    setTimeout(() => {
      handleLocationDetected(geoLoc.lat, geoLoc.lng, `${geoLoc.name}, ${geoLoc.district}`);
    }, 1500);
  };

  const handleLocationTyped = () => {
    setCurrentAction("none");
    inputRef.current?.focus();
  };

  const handleCategoryChipClick = (value: string, label: string) => {
    handleCategorySelect(value, label);
  };

  const handleAvailChipClick = (value: string) => {
    handleAvailabilitySelect(value);
  };

  const [aiUploadingPhotos, setAiUploadingPhotos] = useState(false);
  const uploadPhotoToStorage = async (file: File): Promise<string> => {
    const key = buildUploadKey(`properties/${user?.id}`, file.name);
    const token = await getAccessToken();
    const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
      method: "POST",
      headers: {
        "Content-Type": file.type,
        "x-upload-bucket": "listing-images",
        "x-upload-key": key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(typeof err.error === "string" ? err.error : err.error?.message || "Upload failed");
    }
    const result = await response.json();
    return result.publicUrl as string;
  };

  const handlePhotoFiles = async (files: File[]) => {
    if (!user?.id) {
      toast.error(t("aiOnboarding.signInToUpload", { defaultValue: "Please sign in to upload photos." }));
      return;
    }
    setAiUploadingPhotos(true);
    // Per-file settle so one rejected photo (e.g. the server's NSFW moderation
    // gate, IMAGE_CONTENT_REJECTED) doesn't discard the rest of the batch.
    const results = await Promise.allSettled(files.map(uploadPhotoToStorage));
    const urls = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    if (urls.length > 0) {
      setProfile(prev => ({ ...prev, photos: [...prev.photos, ...urls] }));
      toast.success(t("aiOnboarding.photosAdded", { defaultValue: "{{count}} photo(s) added", count: urls.length }));
      handleInput(t("aiOnboarding.uploadedPhotosMessage", { defaultValue: "I've uploaded {{count}} photo(s).", count: urls.length }));
    }
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        toast.error(`${files[i].name}: ${errorMessage(r.reason, t("aiOnboarding.photoUploadFailed", { defaultValue: "Photo upload failed" }))}`);
      }
    });
    setAiUploadingPhotos(false);
  };

  const handleOptionClick = (value: string, label: string) => {
    if (currentAction === "category_select") handleCategoryChipClick(value, label);
    else if (currentAction === "availability_select") handleAvailChipClick(value);
    else handleInput(label);
  };

  // Pick the right dashboard for the user, AND deep-link to the
  // listing they just created so they land on it directly instead of
  // the dashboard root (which preselects the first listing in their
  // account — confusing when you just published a new one). Transport
  // listings live under /dashboard/transport, not /dashboard/provider.
  const getDashboardRoute = () => {
    const base = isHost
      ? "/dashboard/host"
      : isTransport
        ? "/dashboard/transport"
        : "/dashboard/provider";
    return createdListingId
      ? `${base}?listing=${encodeURIComponent(createdListingId)}`
      : base;
  };

  // Map Live voice hook state → header status text. Keep the same vocabulary
  // the old useVoiceAssistant exposed so the visual treatment stays steady.
  const liveStatusLabel = (() => {
    switch (live.state) {
      case "connecting": return t("aiOnboarding.statusConnecting", { defaultValue: "Connecting..." });
      case "listening": return t("aiOnboarding.statusListening", { defaultValue: "Listening..." });
      case "speaking": return t("aiOnboarding.statusSpeaking", { defaultValue: "Speaking..." });
      case "permission_denied": return t("aiOnboarding.statusMicBlocked", { defaultValue: "Mic blocked" });
      case "error": return t("aiOnboarding.statusVoiceError", { defaultValue: "Voice error" });
      default: return t("aiOnboarding.statusTapMic", { defaultValue: "Tap mic to talk" });
    }
  })();
  const liveStatusTone =
    live.state === "listening" ? "text-primary" :
    live.state === "speaking" ? "text-accent" :
    live.state === "connecting" ? "text-muted-foreground" :
    live.state === "error" || live.state === "permission_denied" ? "text-destructive" :
    "text-success";
  const liveDotTone =
    live.state === "listening" ? "bg-primary animate-pulse" :
    live.state === "speaking" ? "bg-accent animate-pulse" :
    live.state === "connecting" ? "bg-muted-foreground animate-pulse" :
    live.state === "error" || live.state === "permission_denied" ? "bg-destructive" :
    "bg-success";

  const toggleVoice = useCallback(() => {
    if (live.state === "idle" || live.state === "error" || live.state === "permission_denied") {
      live.start().catch(() => { /* state already reflects */ });
    } else {
      live.stop();
    }
  }, [live]);

  // Pre-load any verification documents the provider has already uploaded
  // so the KYC step doesn't re-ask for them. Without this, a returning
  // user who finished KYC earlier still sees every doc as "Upload" — and
  // would re-upload the same Aadhaar / driving licence they already have
  // approved. We populate the same `kycUploaded` map the UI reads from.
  useEffect(() => {
    if (!isComplete || !showKyc || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const docs = await getVerificationService().getDocuments();
        if (cancelled || !docs.success || !docs.data) return;
        const map: Record<string, "pending" | "approved" | "rejected"> = {};
        for (const d of docs.data) {
          // Only show the doc as "uploaded" when it's not been rejected —
          // a rejected one should still prompt re-upload.
          const status = d.status === "approved" ? "approved"
            : d.status === "rejected" ? "rejected"
            : "pending";
          if (status !== "rejected") {
            map[d.documentType] = status;
          }
        }
        setKycUploaded((prev) => {
          const next = { ...map, ...prev };
          // If every required doc is already uploaded, skip the KYC step
          // entirely and drop the user on the success screen. They've
          // done this work before; making them tap "Continue" is friction.
          const requiredTypes = isTransport ? ["aadhaar", "driving_license"] : ["aadhaar"];
          if (requiredTypes.every((t) => next[t])) {
            setShowKyc(false);
          }
          return next;
        });
      } catch {
        // best-effort — failure just means the user sees the empty default
      }
    })();
    return () => { cancelled = true; };
  }, [isComplete, isTransport, showKyc, user?.id]);

  // KYC Verification step
  if (isComplete && showKyc) {
    const kycDocTypes = [
      { type: "aadhaar", label: t("aiOnboarding.kycAadhaarLabel", { defaultValue: "Aadhaar Card" }), description: t("aiOnboarding.kycAadhaarDesc", { defaultValue: "Government-issued identity (mandatory)" }), icon: <IdCard className="w-5 h-5" />, required: true },
      ...(isTransport ? [{ type: "driving_license", label: t("aiOnboarding.kycLicenseLabel", { defaultValue: "Driving License" }), description: t("aiOnboarding.kycLicenseDesc", { defaultValue: "Required for transport providers" }), icon: <Car className="w-5 h-5" />, required: true }] : []),
      { type: "pan_card", label: t("aiOnboarding.kycPanLabel", { defaultValue: "PAN Card" }), description: t("aiOnboarding.kycPanDesc", { defaultValue: "Tax identification (recommended)" }), icon: <CreditCard className="w-5 h-5" />, required: false },
    ];

    const handleKycFileSelect = (docType: string) => {
      kycFileRefs.current[docType]?.click();
    };

    const handleKycFileChange = async (docType: string, e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast.error(t("aiOnboarding.fileTooLarge", { defaultValue: "File must be under 5MB" })); return; }
      const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
      if (!allowed.includes(file.type)) { toast.error(t("aiOnboarding.fileTypeInvalid", { defaultValue: "Only JPG, PNG, WebP, or PDF accepted" })); return; }

      setKycUploading(docType);
      try {
        if (!user?.id) {
          toast.error(t("aiOnboarding.signInToUploadDocs", { defaultValue: "You must be signed in to upload documents." }));
          setKycUploading(null);
          return;
        }
        const result = await getVerificationService().uploadDocument({
          userId: user.id,
          documentType: docType,
          file,
        });
        if (result.success) {
          setKycUploaded(prev => ({ ...prev, [docType]: "approved" }));
          toast.success(t("aiOnboarding.docUploaded", { defaultValue: "{{doc}} uploaded!", doc: kycDocTypes.find(d => d.type === docType)?.label || t("aiOnboarding.docFallback", { defaultValue: "Document" }) }));
          void queryClient.invalidateQueries({ queryKey: ["provider-profile"] });
        } else {
          toast.error(result.error || t("aiOnboarding.uploadFailed", { defaultValue: "Upload failed" }));
        }
      } catch (err: unknown) {
        toast.error(errorMessage(err, t("aiOnboarding.uploadFailed", { defaultValue: "Upload failed" })));
      } finally {
        setKycUploading(null);
      }
    };

    const requiredDone = kycDocTypes.filter(d => d.required).every(d => kycUploaded[d.type]);

    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4">
        <div className="max-w-lg w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="text-center mb-6">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8" />
            </div>
            <h1 className="font-display text-2xl font-bold text-foreground mb-2">{t("aiOnboarding.verifyIdentityTitle", { defaultValue: "Verify Your Identity" })}</h1>
            <p className="text-muted-foreground text-sm">
              {t("aiOnboarding.verifyIdentityBody", { defaultValue: "Upload your documents to get verified and build trust with customers." })}
            </p>
          </div>

          <div className="space-y-3 mb-6">
            {kycDocTypes.map(doc => {
              const uploaded = kycUploaded[doc.type];
              const isUploading = kycUploading === doc.type;
              return (
                <div key={doc.type} className="bg-card rounded-2xl border border-border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        {doc.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-sm">{doc.label}</h4>
                          {doc.required && <span className="text-[9px] font-bold uppercase text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-full">{t("aiOnboarding.requiredBadge", { defaultValue: "Required" })}</span>}
                        </div>
                        <p className="text-xs text-muted-foreground">{doc.description}</p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {uploaded ? (
                        <span className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-success/10 text-success border border-success/20">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {t("aiOnboarding.uploaded", { defaultValue: "Uploaded" })}
                        </span>
                      ) : (
                        <Button
                          size="sm" variant="outline" className="rounded-xl text-xs"
                          onClick={() => handleKycFileSelect(doc.type)}
                          disabled={isUploading}
                        >
                          {isUploading ? (
                            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 animate-spin" /> {t("aiOnboarding.uploading", { defaultValue: "Uploading..." })}</span>
                          ) : (
                            <span className="flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> {t("aiOnboarding.upload", { defaultValue: "Upload" })}</span>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                  <input
                    ref={(el) => { kycFileRefs.current[doc.type] = el; }}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(e) => handleKycFileChange(doc.type, e)}
                  />
                </div>
              );
            })}
          </div>

          <div className="bg-muted/50 rounded-xl p-3 mb-6 text-xs text-muted-foreground flex items-start gap-2">
            <FileCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <span>{t("aiOnboarding.kycGuidelineNote", { defaultValue: "Documents must be clear scans or photos. JPG, PNG, WebP, or PDF under 5MB. Verification is typically instant in test mode." })}</span>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setShowKyc(false)}>
              {t("aiOnboarding.skipForNow", { defaultValue: "Skip for now" })}
            </Button>
            <Button
              className="flex-1 rounded-xl font-semibold"
              onClick={() => setShowKyc(false)}
              disabled={!requiredDone && Object.keys(kycUploaded).length === 0}
            >
              {requiredDone ? t("aiOnboarding.continue", { defaultValue: "Continue" }) : Object.keys(kycUploaded).length > 0 ? t("aiOnboarding.continue", { defaultValue: "Continue" }) : t("aiOnboarding.uploadToContinue", { defaultValue: "Upload to continue" })}
            </Button>
          </div>
          <p className="text-center text-[11px] text-muted-foreground mt-3">
            {t("aiOnboarding.completeLaterDashboard", { defaultValue: "You can also complete this later from your dashboard." })}
          </p>
        </div>
      </div>
    );
  }

  // Success screen
  if (isComplete) {
    const hasKycDocs = Object.keys(kycUploaded).length > 0;
    const allRequiredUploaded = (() => {
      const required = [{ type: "aadhaar" }];
      if (isTransport) required.push({ type: "driving_license" });
      return required.every(d => kycUploaded[d.type]);
    })();

    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center animate-in fade-in zoom-in-95 duration-500">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-success/20 to-accent/20 flex items-center justify-center mx-auto mb-6 animate-bounce">
            <span className="text-5xl">{allRequiredUploaded ? "🎉" : "📋"}</span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-foreground mb-3">
            {allRequiredUploaded ? t("aiOnboarding.listingSubmitted", { defaultValue: "Listing Submitted!" }) : t("aiOnboarding.listingCreated", { defaultValue: "Listing Created!" })}
          </h1>
          <p className="text-muted-foreground mb-2">
            {allRequiredUploaded
              ? t("aiOnboarding.successBodyComplete", { defaultValue: "Your required details and verification documents are complete. Activate the listing from your dashboard when you're ready." })
              : t("aiOnboarding.successBodySaved", { defaultValue: "Your listing has been saved. Complete verification to go public." })}
          </p>
          <div className="bg-card border border-border rounded-2xl p-5 mb-4 text-left">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-xl">
                {isHost ? "🏨" : isTransport ? "🚗" : "🔧"}
              </div>
              <div>
                <p className="font-semibold text-foreground">{profile.name}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" />{profile.location}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium">
              {allRequiredUploaded ? (
                <><span className="w-2 h-2 rounded-full bg-success" /><span className="text-success">{t("aiOnboarding.readyForActivation", { defaultValue: "Ready for activation" })}</span></>
              ) : (
                <><span className="w-2 h-2 rounded-full bg-yellow-500" /><span className="text-yellow-700">{t("aiOnboarding.hiddenPendingVerification", { defaultValue: "Hidden — pending verification" })}</span></>
              )}
            </div>
          </div>
          {hasKycDocs && allRequiredUploaded && (
            <div className="flex items-center gap-2 justify-center text-xs text-success mb-4">
              <Shield className="w-3.5 h-3.5" /> {t("aiOnboarding.identityVerifiedFinish", { defaultValue: "Identity verified — finish activation from the dashboard" })}
            </div>
          )}
          {!allRequiredUploaded && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 mb-4 text-xs text-yellow-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {hasKycDocs
                ? t("aiOnboarding.someDocsMissing", { defaultValue: "Some required documents are still missing. Upload them from your dashboard before making the listing public." })
                : t("aiOnboarding.uploadKycFromDashboard", { defaultValue: "Upload your KYC documents from the dashboard to make your listing public." })}
            </div>
          )}
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => navigate("/")}>{t("aiOnboarding.goHome", { defaultValue: "Go Home" })}</Button>
            <Button className="flex-1 rounded-xl font-semibold" onClick={() => navigate(getDashboardRoute())}>
              {t("aiOnboarding.dashboard", { defaultValue: "Dashboard" })} <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Form mode
  if (mode === "form") {
    return (
      <>
        <OnboardingForm
          profile={profile}
          setProfile={setProfile}
          isSubmitting={formSubmitting}
          showMissingOnMount={showFormMissing}
          allowedGroups={allowedGroups}
          onSwitchToAI={() => {
            setShowFormMissing(false);
            setMode("ai");
          }}
          // Phase 4: don't create immediately. Stash the (already-validated)
          // payload and show the review overlay; the actual create runs on
          // the preview's Confirm. Edit returns to this same form.
          onSubmit={async (extra) => {
            setFormReview(extra ?? {});
          }}
        />
        {formReview && (
          <OnboardingPreview
            profile={profile}
            isHost={isHost}
            isTransport={isTransport}
            reviewOnly
            onConfirm={async () => {
              setFormSubmitting(true);
              try {
                const pendingRooms = (formReview.pendingRooms || []).map((r) => ({
                  name: r.name.trim(),
                  description: r.description.trim(),
                  basePricePaise: Math.round(Number(r.pricePerNight) * 100),
                  maxGuests: r.maxGuests,
                  quantity: r.quantity || 1,
                  bedrooms: r.bedrooms ?? 1,
                  bathrooms: r.bathrooms ?? 1,
                  unitIdentifiers: r.unitIdentifiers ?? [],
                  // Per-room amenities authored in the room editor. Empty
                  // array is fine — listing-level amenities (if any) still
                  // surface for legacy / single-unit fallback.
                  amenities: r.amenities ?? [],
                  photos: r.photos,
                }));
                await confirmAndSubmit({ pendingRooms });
                // Publish succeeded — drop the saved draft so the next visit
                // starts clean. On failure we keep the draft so the user can
                // fix + retry or close the tab and resume later.
                clearOnboardingDraft(user?.id, draftType);
                setFormReview(null);
                setShowKyc(true);
              } catch {
                // confirmAndSubmit surfaces its own toast on failure; keep
                // the review open so the user can retry or edit.
              } finally {
                setFormSubmitting(false);
              }
            }}
            onEdit={() => setFormReview(null)}
            lang={displayLang}
          />
        )}
      </>
    );
  }

  return (
    // The site Navbar is sticky h-16 (4rem) above every route, so a raw
    // 100dvh container pushes its own bottom (input bar) below the
    // visible viewport. Subtract the navbar height so the chat header,
    // messages, voice pill, and input bar all fit without scrolling.
    <div className="h-[calc(100dvh-4rem)] bg-background flex flex-col relative overflow-hidden">
      {showLangSettings && (
        <LanguageSettings
          displayLang={displayLang}
          spokenInputLang={spokenInputLang}
          onDisplayLangChange={setDisplayLang}
          onSpokenInputLangChange={setSpokenInputLang}
          onClose={() => setShowLangSettings(false)}
        />
      )}
      {showPreview && (
        <OnboardingPreview
          profile={profile}
          isHost={isHost}
          isTransport={isTransport}
          onConfirm={async (previewRooms) => {
            if (routeToMissingFields(previewRooms)) return;
            const pendingRooms = (previewRooms || [])
              .filter((r) => r.name.trim() && r.pricePerNight)
              .map((r, i) => ({
                name: r.name.trim(),
                description: "",
                basePricePaise: Math.round(Number(r.pricePerNight) * 100),
                maxGuests: r.maxGuests,
                quantity: r.quantity || 1,
                // Carry over agent-extracted per-room amenities (the
                // preview UI can't edit them; the Form toggle can).
                amenities: Array.isArray(r.amenities) ? r.amenities : [],
                photos: [],
                sortOrder: i,
              }));
            await confirmAndSubmit(pendingRooms.length ? { pendingRooms } : undefined);
            // Same contract as the form-mode submit: clear the saved
            // draft only after publish actually returns. confirmAndSubmit
            // throws on failure, so an error skips this line and the
            // draft persists for the user to resume.
            clearOnboardingDraft(user?.id, draftType);
            setShowKyc(true);
          }}
          // Phase 4: Edit drops the user into the manual form (pre-filled
          // from the shared profile) so they can edit anything — not back
          // into the chat. Stop Live voice first so the mic isn't left open.
          onEdit={() => {
            live.stop();
            setShowPreview(false);
            setMode("form");
          }}
          lang={displayLang}
        />
      )}

      <div className="bg-card border-b border-border px-4 py-2.5 flex items-center gap-3 shrink-0 z-10">
        <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shrink-0 shadow-sm">
          <Bot className="w-4 h-4 text-primary-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-sm text-foreground">Ista AI</p>
          <p className={`text-[10px] font-medium flex items-center gap-1 ${liveStatusTone}`}>
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${liveDotTone}`} />
            {liveStatusLabel}
          </p>
        </div>

        {progress.filled > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-20 sm:w-24 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all duration-700 ease-out" style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground font-medium whitespace-nowrap">{progress.filled}/{progress.total}</span>
          </div>
        )}

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => {
              // Stop the Live voice channel before switching to form so the
              // mic isn't held open behind a UI that doesn't show its state.
              live.stop();
              setMode("form");
            }}
            title={t("aiOnboarding.switchToForm", { defaultValue: "Switch to form input" })}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <FileText className="w-4 h-4" />
          </button>
          {/* Mic toggle moved into the LiveVoicePill below — having two
              start/stop controls in the header was confusing and wasted
              space. The pill is the single source of voice control. */}
          <button
            onClick={() => setShowLangSettings(true)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Globe className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Chat fills the remaining viewport. ConversationPanel scrolls its
          own messages internally (overflow-y-auto inside) so the page itself
          doesn't scroll — the input bar + status pill stay pinned. */}
      <ConversationPanel
        messages={messages}
        isProcessing={isProcessing}
        interimTranscript={interimTranscript}
        onOptionClick={handleOptionClick}
      />

      {/* Captured-fields strip — slim row above the action overlay so hosts
          see what the agent has caught. Hidden until something's captured. */}
      {(profile.name || profile.category || profile.location) && (
        <div className="shrink-0 px-4 pt-1.5 pb-1 border-t border-border/50 flex flex-wrap gap-1.5 justify-center bg-card">
          {profile.category && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary rounded-full">
              {profile.category}
            </span>
          )}
          {/* Render each sub-skill as its own chip so the multi-value array
              the AI just collected is visible at a glance. Falls back to the
              legacy scalar when an older listing only has the single value. */}
          {(profile.subcategories?.length
              ? profile.subcategories
              : (profile.subcategory ? [profile.subcategory] : [])
          ).map((s, i) => (
            <span key={`${s}-${i}`} className="px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary rounded-full">
              {s}
            </span>
          ))}
          {profile.name && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-accent/10 text-accent rounded-full">
              {profile.name}
            </span>
          )}
          {profile.location && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-success/10 text-success rounded-full flex items-center gap-1">
              <MapPin className="w-2.5 h-2.5" />{profile.location}
            </span>
          )}
          {profile.experience && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground rounded-full">
              {profile.experience}
            </span>
          )}
          {profile.duration && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground rounded-full">
              {profile.duration}
            </span>
          )}
          {profile.price && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground rounded-full">
              {profile.price}
            </span>
          )}
          {/* Radius chip only makes sense when the provider travels to the
              customer (at-home). Visit-provider / online don't have a
              meaningful travel radius, so suppress the chip in those cases
              even if the AI parser populated a default. Mirrors the manual
              onboarding + edit-listing + customer detail page rules. */}
          {profile.serviceRadius > 0
            && Array.isArray(profile.serviceModes)
            && profile.serviceModes.includes("at-home") && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground rounded-full">
              {profile.serviceRadius} km
            </span>
          )}
          {profile.availability && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground rounded-full">
              {profile.availability}
            </span>
          )}
          {profile.serviceModes && profile.serviceModes.length > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary rounded-full">
              {profile.serviceModes.join(", ")}
            </span>
          )}
        </div>
      )}

      <ActionOverlay
        action={currentAction}
        onLocationShare={handleLocationShare}
        onLocationTyped={handleLocationTyped}
        onCategorySelect={handleCategoryChipClick}
        onAvailabilitySelect={handleAvailChipClick}
        onPhotoFiles={handlePhotoFiles}
        isLocating={isLocating}
        isUploadingPhotos={aiUploadingPhotos}
      />

      {/* Compact live-voice status pill — same UX as the customer-side
          AssistantWidget. No big tap-to-speak orb; the mic auto-starts on
          page open and stays hot. The pill shows current state and a
          single contextual button (End / Retry / Start). */}
      <LiveVoicePill live={live} onToggle={toggleVoice} />

      <div className="border-t border-border bg-card px-4 py-2.5 shrink-0">
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSendText()}
              placeholder={live.state === "listening" ? t("aiOnboarding.listeningPlaceholder", { defaultValue: "Listening..." }) : t("aiOnboarding.typeOrSpeakPlaceholder", { defaultValue: "Type or speak..." })}
              className="w-full px-4 py-2 bg-muted border border-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
            />
          </div>
          <Button
            onClick={handleSendText}
            disabled={!input.trim() || isProcessing}
            size="icon"
            className="rounded-xl shrink-0 w-9 h-9"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * Compact voice-status pill — mirrors the customer-side AssistantWidget's
 * live-voice control. No tap-to-speak: the mic auto-starts when the user
 * lands on the page (see useEffect in AIOnboarding) and the pill just
 * surfaces state + a single action button. Pattern lifted from
 * src/components/assistant/AssistantWidget.tsx so the two surfaces feel
 * identical to a host who's also used Sathi as a customer.
 */
const LiveVoicePill = ({
  live, onToggle,
}: {
  live: ReturnType<typeof useGeminiLiveVoice>;
  onToggle: () => void;
}) => {
  const { t } = useLanguage();
  const dotClass =
    live.state === "listening" ? "text-green-600 animate-pulse" :
    live.state === "speaking" ? "text-orange-500 animate-pulse" :
    live.state === "permission_denied" ? "text-amber-600" :
    live.state === "error" ? "text-red-500" :
    live.state === "connecting" ? "text-muted-foreground animate-pulse" :
    "text-muted-foreground";

  const stateLabel =
    live.state === "idle" ? t("aiOnboarding.pillTapStart", { defaultValue: "Tap Start to talk" }) :
    live.state === "connecting" ? t("aiOnboarding.pillConnecting", { defaultValue: "Connecting…" }) :
    live.state === "listening" ? t("aiOnboarding.pillListening", { defaultValue: "Listening — just talk" }) :
    live.state === "speaking" ? t("aiOnboarding.pillSpeaking", { defaultValue: "Ista AI is speaking" }) :
    live.state === "permission_denied" ? t("aiOnboarding.pillMicBlocked", { defaultValue: "Mic blocked — enable in browser settings" }) :
    live.state === "error" ? (live.lastError || t("aiOnboarding.pillVoiceError", { defaultValue: "Voice error" })) :
    "";

  // Single mic toggle replaces the prior Start / Retry / End-call cluster.
  // Mic ON = AI listens + speaks (Gemini Live WS). Mic OFF = silent text
  // assistant. Tapping while mid-sentence stops it instantly because
  // liveVoice.stop() closes the WebSocket and the AudioContext.
  const isLive = live.state === "connecting"
    || live.state === "listening"
    || live.state === "speaking";

  return (
    <div className="shrink-0 px-3 py-2 border-t border-border bg-card">
      <div className="max-w-2xl mx-auto flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5">
        <div className="flex items-center gap-2 text-xs min-w-0">
          <Radio className={`h-3.5 w-3.5 shrink-0 ${dotClass}`} />
          <span className="font-medium shrink-0">{t("aiOnboarding.liveVoice", { defaultValue: "Live voice" })}</span>
          <span className="text-muted-foreground truncate">{stateLabel}</span>
        </div>
        <Button
          type="button"
          size="icon"
          variant={isLive ? "default" : "outline"}
          onClick={onToggle}
          aria-label={isLive ? t("aiOnboarding.muteMic", { defaultValue: "Mute mic" }) : t("aiOnboarding.tapToStartVoice", { defaultValue: "Tap to start voice" })}
          aria-pressed={isLive}
          className={
            isLive
              ? "h-8 w-8 rounded-full shrink-0 bg-rose-500 hover:bg-rose-600 text-white border-rose-500"
              : "h-8 w-8 rounded-full shrink-0"
          }
        >
          {isLive ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
};

export default AIOnboarding;
