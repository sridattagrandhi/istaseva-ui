// Mock booking dialog used by the redesigned marketplace surfaces.
// UI-only: no real API calls. Stays/services/transport all flow through here
// during the visual-design phase so we can iterate on the booking experience
// without committing to backend shapes for services/transport.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Lock,
  Phone,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { MarketplaceBookingDraft } from "@/types/marketplace";

type Props = {
  draft: MarketplaceBookingDraft | null;
  onClose: () => void;
};

function rupee(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function MarketplaceBookingDialog({ draft, onClose }: Props) {
  const { isAuthenticated, user } = useAuth();
  const { t } = useLanguage();
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [stage, setStage] = useState<"form" | "success">("form");

  // Seed contact fields from the signed-in user, and reset stage whenever a
  // new draft opens so the dialog never starts on the success screen.
  useEffect(() => {
    if (!draft) return;
    setStage("form");
    setContactName(user?.name ?? "");
    setContactPhone(user?.phone ?? "");
  }, [draft, user]);

  // Lock body scroll while the dialog is open.
  useEffect(() => {
    if (!draft) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [draft]);

  if (!draft) return null;

  const { price } = draft;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 px-3 pb-3 pt-6 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[640px] overflow-hidden rounded-[20px] border border-white/70 bg-white/95 shadow-[0_28px_86px_rgba(34,31,39,0.22)] backdrop-blur-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("rd.bdlg.closeDialog", { defaultValue: "Close booking dialog" })}
          className="absolute right-3 top-3 z-10 inline-grid h-9 w-9 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm transition-all hover:bg-muted active:scale-95"
        >
          <X className="h-4 w-4" />
        </button>

        {stage === "success" ? (
          <SuccessPanel draft={draft} onClose={onClose} />
        ) : !isAuthenticated ? (
          <LoginGate draft={draft} />
        ) : (
          <FormPanel
            draft={draft}
            contactName={contactName}
            setContactName={setContactName}
            contactPhone={contactPhone}
            setContactPhone={setContactPhone}
            onConfirm={() => setStage("success")}
          />
        )}

        {stage !== "success" && isAuthenticated && (
          <PriceFooter price={price} onConfirm={() => setStage("success")} />
        )}
      </div>
    </div>
  );
}

function ItemSummary({ draft }: { draft: MarketplaceBookingDraft }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
      <div
        className="h-14 w-20 shrink-0 rounded-xl bg-cover bg-center"
        style={{ backgroundImage: `url(${draft.image})` }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-accent">
          {draft.kind === "stay"
            ? t("rd.bdlg.stayBooking", { defaultValue: "Stay booking" })
            : draft.kind === "service"
              ? t("rd.bdlg.serviceBooking", { defaultValue: "Service booking" })
              : t("rd.bdlg.transportBooking", { defaultValue: "Transport booking" })}
        </p>
        <p className="truncate font-display text-base font-bold text-foreground">{draft.title}</p>
        <p className="truncate text-xs text-muted-foreground">{draft.subtitle}</p>
      </div>
    </div>
  );
}

function FormPanel({
  draft,
  contactName,
  contactPhone,
  setContactName,
  setContactPhone,
  onConfirm: _onConfirm,
}: {
  draft: MarketplaceBookingDraft;
  contactName: string;
  contactPhone: string;
  setContactName: (v: string) => void;
  setContactPhone: (v: string) => void;
  onConfirm: () => void;
}) {
  const { t } = useLanguage();
  return (
    <>
      <ItemSummary draft={draft} />
      <div className="space-y-5 px-5 py-4">
        {draft.date && (
          <Row icon={<CalendarDays className="h-4 w-4" />} label={t("rd.bdlg.dateLabel", { defaultValue: "Date" })}>
            <span className="text-sm font-semibold text-foreground">{draft.date}</span>
          </Row>
        )}
        {draft.slot && (
          <Row icon={<Sparkles className="h-4 w-4" />} label={t("rd.bdlg.slotLabel", { defaultValue: "Slot" })}>
            <span className="text-sm font-semibold text-foreground">{draft.slot}</span>
          </Row>
        )}
        {draft.options && draft.options.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.bdlg.selectedOptions", { defaultValue: "Selected options" })}</p>
            <div className="flex flex-wrap gap-2">
              {draft.options.map((opt) => (
                <span
                  key={opt.value}
                  className="inline-flex items-center gap-1 rounded-full border border-white/70 bg-muted px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-foreground"
                >
                  <Check className="h-3 w-3" /> {opt.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.bdlg.nameLabel", { defaultValue: "Name" })}</span>
            <div className="flex items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <User className="h-4 w-4 text-muted-foreground" />
              <input
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                placeholder={t("rd.bdlg.namePlaceholder", { defaultValue: "Your full name" })}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </label>
          <label className="grid gap-1.5">
            <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.bdlg.phoneLabel", { defaultValue: "Phone" })}</span>
            <div className="flex items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <input
                value={contactPhone}
                onChange={(event) => setContactPhone(event.target.value)}
                placeholder="+91 9XXXXXXXXX"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </label>
        </div>

        <PriceBreakdown draft={draft} />
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-success" /> {t("rd.bdlg.mockBookingNote", { defaultValue: "Mock booking — no payment is taken in this preview." })}
        </div>
      </div>
    </>
  );
}

function PriceBreakdown({ draft }: { draft: MarketplaceBookingDraft }) {
  const { price } = draft;
  const { t } = useLanguage();
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 p-3">
      <p className="mb-2 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.bdlg.priceBreakdown", { defaultValue: "Price breakdown" })}</p>
      <div className="grid gap-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{price.baseLabel}</span>
          <span className="font-semibold text-foreground">{rupee(price.base)}</span>
        </div>
        {price.addOns.map((add) => (
          <div key={add.label} className="flex items-center justify-between">
            <span className="text-muted-foreground">{add.label}</span>
            <span className="font-semibold text-foreground">{rupee(add.amount)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t("rd.bdlg.taxesFees", { defaultValue: "Taxes & fees" })}</span>
          <span className="font-semibold text-foreground">{rupee(price.taxes)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2">
          <span className="font-bold text-foreground">{t("rd.bdlg.total", { defaultValue: "Total" })}</span>
          <span className="font-display text-base font-extrabold text-foreground">{rupee(price.total)}</span>
        </div>
      </div>
    </div>
  );
}

function PriceFooter({
  price,
  onConfirm,
}: {
  price: MarketplaceBookingDraft["price"];
  onConfirm: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 bg-white/85 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.bdlg.total", { defaultValue: "Total" })}</p>
        <p className="font-display text-lg font-extrabold text-foreground">{rupee(price.total)}</p>
      </div>
      <button
        type="button"
        onClick={onConfirm}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] transition-transform hover:-translate-y-0.5"
        style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
      >
        {t("rd.bdlg.confirmBooking", { defaultValue: "Confirm booking" })} <Check className="h-4 w-4" />
      </button>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </span>
      {children}
    </div>
  );
}

function LoginGate({ draft }: { draft: MarketplaceBookingDraft }) {
  const { t } = useLanguage();
  return (
    <>
      <ItemSummary draft={draft} />
      <div className="grid gap-4 px-5 py-6 text-center">
        <div className="mx-auto inline-grid h-14 w-14 place-items-center rounded-2xl bg-muted text-foreground">
          <Lock className="h-6 w-6" />
        </div>
        <div>
          <h3 className="font-display text-lg font-bold text-foreground">{t("rd.bdlg.loginToContinue", { defaultValue: "Log in to continue" })}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("rd.bdlg.loginGateBody", { defaultValue: "We use your account to confirm bookings, send updates, and keep your trip history together." })}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Link
            to="/login"
            className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-bold text-foreground shadow-sm transition-colors hover:bg-muted active:bg-muted/70"
          >
            {t("rd.bdlg.login", { defaultValue: "Login" })}
          </Link>
          <Link
            to="/signup"
            className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]"
            style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}
          >
            {t("rd.bdlg.createAccount", { defaultValue: "Create account" })}
          </Link>
        </div>
      </div>
    </>
  );
}

function SuccessPanel({ draft, onClose }: { draft: MarketplaceBookingDraft; onClose: () => void }) {
  const { t } = useLanguage();
  const timing = draft.slot || draft.date || t("rd.bdlg.confirmTimingSoon", { defaultValue: "we'll confirm timing shortly" });
  const kindLabel =
    draft.kind === "stay"
      ? t("rd.bdlg.kindStays", { defaultValue: "stays" })
      : draft.kind === "service"
        ? t("rd.bdlg.kindServices", { defaultValue: "services" })
        : t("rd.bdlg.kindTransport", { defaultValue: "transport" });
  return (
    <div className="grid gap-4 px-5 py-8 text-center">
      <div className="mx-auto inline-grid h-16 w-16 place-items-center rounded-full bg-success/15 text-success">
        <CheckCircle2 className="h-8 w-8" />
      </div>
      <div>
        <h3 className="font-display text-xl font-extrabold text-foreground">{t("rd.bdlg.bookingRequestSent", { defaultValue: "Booking request sent" })}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("rd.bdlg.successTiming", { defaultValue: "{{title}} — {{timing}}.", title: draft.title, timing })}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("rd.bdlg.previewConfirmation", { defaultValue: "This is a preview confirmation. Real payment and provider acceptance will come once {{kind}} are fully wired to backend.", kind: kindLabel })}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mx-auto inline-flex h-10 items-center gap-2 rounded-full border border-border bg-card px-5 text-sm font-bold text-foreground shadow-sm transition-colors hover:bg-muted active:bg-muted/70"
      >
        {t("rd.bdlg.close", { defaultValue: "Close" })}
      </button>
    </div>
  );
}
