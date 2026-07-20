import { useState, type ComponentProps } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import OnboardingForm from "@/components/onboarding/OnboardingForm";
import {
  EMPTY_PROFILE,
  buildListingCreatePayload,
  type OnboardingProfile,
} from "@/hooks/useConversationEngine";
import { toCreateListingApiBody } from "@/domains/listings/listing.service";
import { clearOnboardingDraft } from "@/lib/onboarding-draft";
import { adminOps } from "@/domains/admin/admin-ops.service";
import { useAuth } from "@/contexts/AuthContext";
import { StateNote } from "./adminUi";

type FormSubmitExtra = NonNullable<Parameters<ComponentProps<typeof OnboardingForm>["onSubmit"]>[0]>;

/**
 * Assisted onboarding: an admin fills the SAME manual onboarding form the
 * hosts use, but for a target user picked on the Listings screen
 * (/admin/listings/new?user=<uid>). Photos upload into the target's storage
 * path, drafts live in an admin-scoped bucket, and submit posts to the
 * admin create-for-user endpoint — the listing lands as a draft on the
 * target's account and THEY publish it from their dashboard.
 */
export default function AdminListingCreate() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user: admin } = useAuth();
  const targetUserId = searchParams.get("user") ?? "";

  const [profile, setProfile] = useState<OnboardingProfile>({ ...EMPTY_PROFILE });
  const [submitting, setSubmitting] = useState(false);

  const targetQuery = useQuery({
    queryKey: ["admin-listing-create-target", targetUserId],
    queryFn: () => adminOps.users.get(targetUserId),
    enabled: targetUserId.length > 0,
  });
  const target = targetQuery.data;

  const blockedReason = !targetUserId
    ? "No target user selected — pick one from the Listings screen."
    : targetQuery.isLoading
      ? null
      : !target
        ? "This user could not be loaded."
        : target.verification_status !== "verified"
          ? "This user must complete KYC verification before a listing can be created on their account."
          : target.is_suspended
            ? "This account is suspended — unsuspend it before creating listings on it."
            : null;

  const handleSubmit = async (extra?: FormSubmitExtra) => {
    if (!target) return;
    setSubmitting(true);
    try {
      const payload = buildListingCreatePayload(profile, {
        providerName: target.display_name || "Provider",
      });
      // Same room mapping as the self-serve flow (AIOnboarding form-mode
      // confirm) — rooms are created server-side as the target owner.
      const rooms = (extra?.pendingRooms ?? [])
        .filter((r) => r.name.trim() && r.pricePerNight)
        .map((r, i) => ({
          name: r.name.trim(),
          description: r.description?.trim() || null,
          base_price_paise: Math.round(Number(r.pricePerNight) * 100),
          max_guests: r.maxGuests,
          quantity: r.quantity || 1,
          bedrooms: r.bedrooms ?? 1,
          bathrooms: r.bathrooms ?? 1,
          unit_identifiers: r.unitIdentifiers ?? [],
          amenities: r.amenities ?? [],
          photos: r.photos,
          sort_order: i,
        }));

      await adminOps.listings.createForUser(
        target.user_id,
        toCreateListingApiBody(payload),
        rooms,
      );
      clearOnboardingDraft(`admin:${admin?.id ?? "anon"}:for:${target.user_id}`, "any");
      toast.success(`Draft listing created on ${target.display_name}'s account — they've been notified.`);
      navigate("/admin/listings");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the listing.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/admin/listings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted/60">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to listings
        </Link>
        {target && (
          <p className="text-sm text-muted-foreground">
            Creating for <span className="font-semibold text-foreground">{target.display_name}</span>
            {" "}<span className="text-xs">({target.email ?? target.user_id}) · KYC {target.verification_status}</span>
          </p>
        )}
      </div>

      {targetQuery.isLoading ? (
        <StateNote>Loading user…</StateNote>
      ) : blockedReason ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert className="h-10 w-10 text-muted-foreground/40" />
          <p className="max-w-md text-sm text-muted-foreground">{blockedReason}</p>
          <Link to="/admin/listings" className="text-sm font-semibold text-primary hover:underline">
            Back to listings
          </Link>
        </div>
      ) : (
        <OnboardingForm
          profile={profile}
          setProfile={setProfile}
          isSubmitting={submitting}
          onSubmit={handleSubmit}
          onSwitchToAI={() => undefined}
          hideAISwitch
          targetUserId={target!.user_id}
        />
      )}
    </>
  );
}
