// Shared Profile tab for the partner dashboards (Host / Provider / Transport).
// Replaces the three hand-rolled read-only "spec sheet" cards with one
// polished, editable surface that matches the app aesthetic: identity card
// with real avatar upload, inline profile editing (name / phone / location),
// KPI tiles, and the role-specific detail rows each dashboard passes in.
// Mirrors the avatar + update flows of the standalone customer /profile page.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Loader2, LogOut, Pencil, Shield, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getUserService } from "@/domains/users/user.service";
import { apiRequest, getAccessToken, getJsonHeaders } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { useMyProfile, MY_PROFILE_KEY } from "@/hooks/use-my-profile";
import type { UserProfile } from "@/types/domain";
import { toast } from "sonner";
import { Kpi, Panel } from "./metric-ui";

const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // well under the server's 10MB cap

/** Best-effort delete of a replaced/removed avatar object (same approach as
 *  the standalone /profile page — failures just leave an orphan for the
 *  account-deletion sweep). */
async function deleteStoredAvatar(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const match = url.match(/\/api\/storage\/serve\/([^/]+)\/(.+)$/);
  if (!match) return;
  const [, bucket, encodedKey] = match;
  const key = encodedKey.split("/").map(decodeURIComponent).join("/");
  await apiRequest("/api/storage/delete", {
    method: "DELETE",
    headers: getJsonHeaders(),
    body: JSON.stringify({ bucket, key }),
  }).catch(() => undefined);
}

export interface ProfileStat {
  label: string;
  value: string;
  sub?: string;
}

export function DashboardProfilePanel({
  roleNoun,
  verified,
  verifiedLabel,
  rating,
  reviewCount,
  stats,
  details,
  onLogout,
}: {
  /** Fallback display name for the role ("Partner" / "Host" / "Driver"). */
  roleNoun: string;
  verified: boolean;
  verifiedLabel: string;
  /** Average rating string ("4.8") — omitted when there are no reviews. */
  rating?: string | null;
  reviewCount?: number;
  /** Role-specific KPI tiles (completed jobs, rating, member since, …). */
  stats: ProfileStat[];
  /** Read-only label/value rows (listings, verification status, …). */
  details: Array<{ label: string; value: string }>;
  onLogout: () => void;
}) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  // Live profile row (user_profiles) — read from the SHARED cache so an avatar
  // change here immediately reflects in the navbar / dashboard header (and
  // vice versa). Writes go back to the same key via setProfile().
  const { data: profile } = useMyProfile();
  const setProfile = (next: UserProfile) => queryClient.setQueryData([MY_PROFILE_KEY, user?.id], next);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inline edit state — seeded from the live profile each time editing opens.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPhone, setDraftPhone] = useState("");
  const [draftLocation, setDraftLocation] = useState("");

  const displayName = profile?.displayName || user?.name || roleNoun;
  const avatarText = user?.avatar || displayName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

  const startEditing = () => {
    setDraftName(profile?.displayName || user?.name || "");
    setDraftPhone(profile?.phone || user?.phone || "");
    setDraftLocation(profile?.location || user?.location || "");
    setEditing(true);
  };

  const saveProfile = async () => {
    if (!user?.id) return;
    const name = draftName.trim();
    if (!name) {
      toast.error(t("dashProfile.nameRequired", { defaultValue: "Please enter your name." }));
      return;
    }
    setSaving(true);
    try {
      const result = await getUserService().updateProfile(user.id, {
        displayName: name,
        phone: draftPhone.trim() || undefined,
        location: draftLocation.trim() || undefined,
      });
      if (!result.success || !result.data) throw new Error(result.success ? "Update failed" : result.error);
      setProfile(result.data);
      setEditing(false);
      toast.success(t("dashProfile.saved", { defaultValue: "Profile updated." }));
    } catch (err: any) {
      toast.error(err?.message || t("dashProfile.saveFailed", { defaultValue: "Couldn't save your profile. Try again." }));
    } finally {
      setSaving(false);
    }
  };

  const changeAvatar = async (file: File) => {
    if (!user?.id) return;
    if (!AVATAR_MIME_TYPES.has(file.type)) {
      toast.error(t("profilePage.avatarBadType", { defaultValue: "Please choose a JPEG, PNG or WEBP image." }));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error(t("profilePage.avatarTooBig", { defaultValue: "Please choose an image under 5MB." }));
      return;
    }
    setAvatarBusy(true);
    try {
      const key = buildUploadKey(`${user.id}/avatar`, file.name);
      const token = await getAccessToken();
      const uploadResponse = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "x-upload-bucket": "uploads",
          "x-upload-key": key,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: file,
      });
      if (!uploadResponse.ok) {
        const err = await uploadResponse.json().catch(() => ({}));
        const msg = typeof err.error === "string" ? err.error : err.error?.message || "Upload failed";
        throw new Error(msg);
      }
      const { publicUrl } = await uploadResponse.json();
      const previousUrl = profile?.avatarUrl;
      const result = await getUserService().updateProfile(user.id, { avatarUrl: publicUrl });
      if (!result.success || !result.data) throw new Error(result.success ? "Update failed" : result.error);
      setProfile(result.data);
      void deleteStoredAvatar(previousUrl);
      toast.success(t("profilePage.avatarUpdated", { defaultValue: "Profile photo updated." }));
    } catch (err: any) {
      toast.error(err?.message || t("profilePage.avatarFailed", { defaultValue: "Couldn't update your photo. Try again." }));
    } finally {
      setAvatarBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAvatar = async () => {
    if (!user?.id || !profile?.avatarUrl) return;
    setAvatarBusy(true);
    try {
      const previousUrl = profile.avatarUrl;
      const result = await getUserService().updateProfile(user.id, { avatarUrl: null as unknown as string });
      if (!result.success || !result.data) throw new Error(result.success ? "Update failed" : result.error);
      setProfile(result.data);
      void deleteStoredAvatar(previousUrl);
      toast.success(t("profilePage.avatarRemoved", { defaultValue: "Profile photo removed." }));
    } catch (err: any) {
      toast.error(err?.message || t("profilePage.avatarFailed", { defaultValue: "Couldn't update your photo. Try again." }));
    } finally {
      setAvatarBusy(false);
    }
  };

  const editableRows: Array<{ label: string; value: string }> = [
    { label: t("dashProfile.phone", { defaultValue: "Phone" }), value: profile?.phone || user?.phone || "—" },
    { label: t("dashProfile.location", { defaultValue: "Location" }), value: profile?.location || user?.location || "—" },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {/* Identity */}
      <div className="bg-card rounded-2xl border border-border p-6 sm:p-8">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative shrink-0">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary to-primary/70 text-primary-foreground flex items-center justify-center text-2xl font-bold shadow-lg shadow-primary/20 overflow-hidden">
                {profile?.avatarUrl ? (
                  <img src={profile.avatarUrl} alt={displayName} className="w-full h-full object-cover" />
                ) : (
                  avatarText
                )}
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarBusy}
                aria-label={t("profilePage.changePhoto", { defaultValue: "Change photo" })}
                className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-card border border-border shadow-md flex items-center justify-center text-foreground hover:bg-muted transition-colors"
              >
                {avatarBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void changeAvatar(f); }}
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-display font-bold text-xl truncate">{displayName}</h3>
              <p className="text-sm text-muted-foreground truncate">{user?.email || "—"}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {verified && (
                  <span className="flex items-center gap-1 text-xs text-success font-medium">
                    <Shield className="w-3 h-3" />{verifiedLabel}
                  </span>
                )}
                {rating && (reviewCount ?? 0) > 0 && (
                  <span className="flex items-center gap-1 text-xs text-secondary font-medium">
                    <Star className="w-3 h-3 fill-secondary" />{rating}
                  </span>
                )}
              </div>
              {profile?.avatarUrl && (
                <button
                  onClick={() => void removeAvatar()}
                  disabled={avatarBusy}
                  className="mt-1.5 text-xs font-medium text-destructive hover:underline inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  {t("profilePage.removePhoto", { defaultValue: "Remove photo" })}
                </button>
              )}
            </div>
          </div>
          {!editing && (
            <Button size="sm" variant="outline" className="rounded-full shrink-0" onClick={startEditing}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              {t("dashProfile.edit", { defaultValue: "Edit profile" })}
            </Button>
          )}
        </div>

        {editing ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t("dashProfile.name", { defaultValue: "Display name" })}</label>
                <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={80} />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t("dashProfile.phone", { defaultValue: "Phone" })}</label>
                <Input value={draftPhone} onChange={(e) => setDraftPhone(e.target.value)} inputMode="tel" maxLength={20} />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t("dashProfile.location", { defaultValue: "Location" })}</label>
                <Input value={draftLocation} onChange={(e) => setDraftLocation(e.target.value)} maxLength={120} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="rounded-full" onClick={() => void saveProfile()} disabled={saving}>
                {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                {t("dashProfile.save", { defaultValue: "Save changes" })}
              </Button>
              <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setEditing(false)} disabled={saving}>
                <X className="w-3.5 h-3.5 mr-1.5" />
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-0">
            {editableRows.map((f) => (
              <div key={f.label} className="flex items-center justify-between py-3.5 border-b border-border last:border-0 gap-3">
                <span className="text-sm text-muted-foreground shrink-0">{f.label}</span>
                <span className="text-sm font-medium text-right truncate">{f.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Role KPIs */}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {stats.map((s) => (
            <Kpi key={s.label} label={s.label} value={s.value} sub={s.sub} />
          ))}
        </div>
      )}

      {/* Role details */}
      {details.length > 0 && (
        <Panel title={t("dashProfile.details", { defaultValue: "Business details" })}>
          <div className="space-y-0">
            {details.map((f) => (
              <div key={f.label} className="flex items-center justify-between py-3 border-b border-border/60 last:border-0 gap-3">
                <span className="text-sm text-muted-foreground shrink-0">{f.label}</span>
                <span className="text-sm font-medium text-right truncate">{f.value}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Account actions */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="rounded-full" asChild>
          <Link to="/provider/verification">
            <ShieldCheck className="w-4 h-4 mr-1.5" />
            {t("dashProfile.verification", { defaultValue: "Manage verification" })}
          </Link>
        </Button>
        <Button
          variant="outline"
          className="rounded-full text-destructive border-destructive/30 hover:bg-destructive/10"
          onClick={onLogout}
        >
          <LogOut className="w-4 h-4 mr-1.5" />
          {t("dashProfile.logout", { defaultValue: "Log out" })}
        </Button>
      </div>
    </div>
  );
}
