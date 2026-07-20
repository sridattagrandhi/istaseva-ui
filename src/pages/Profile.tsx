import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Globe, Shield, ChevronRight, FileText, MessageCircle, ShieldCheck, Camera, Trash2, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import AccountPrivacyPanel from "@/components/account/AccountPrivacyPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage, languages } from "@/contexts/LanguageContext";
import { getLegalService } from "@/domains/legal/legal.service";
import { getUserService } from "@/domains/users/user.service";
import { apiRequest, getAccessToken, getJsonHeaders } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { useMyProfile, MY_PROFILE_KEY } from "@/hooks/use-my-profile";
import type { UserProfile } from "@/types/domain";
import { toast } from "sonner";

const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // well under the server's 10MB cap

/** Best-effort delete of a replaced/removed avatar object. The public URL is
 *  the ownership-checked serve route, so bucket+key can be recovered from it;
 *  failure just leaves an orphan that the account-deletion sweep cleans up. */
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

/**
 * Standalone profile & account page (/profile). Replaces the old Profile tab
 * on the guest dashboard: identity, preferences, communication consent, and
 * the Privacy & data panel (DSAR export + account deletion, PRIV-002) all
 * live here, plus quick links to the legal documents.
 */
const Profile = () => {
  const { user } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Live profile row (user_profiles) — read from the SHARED cache so an avatar
  // change here reflects in the navbar / dashboards immediately (and vice
  // versa). Writes go back to the same key via setProfile().
  const { data: profile } = useMyProfile();
  const setProfile = (next: UserProfile) => queryClient.setQueryData([MY_PROFILE_KEY, user?.id], next);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // Ownership-scoped key (<uid>/avatar/...) through the moderated,
      // owner-checked proxy upload — same path KYC and listing images use.
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

  // Marketing-consent toggle. Reads the latest state once on mount; the PUT
  // appends to the consent trail (latest row wins server-side).
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [marketingConsentSaving, setMarketingConsentSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getLegalService().hasMarketingConsent().then((granted) => {
      if (!cancelled) setMarketingConsent(granted);
    });
    return () => { cancelled = true; };
  }, []);
  const toggleMarketingConsent = async (granted: boolean) => {
    setMarketingConsent(granted); // optimistic — revert on failure
    setMarketingConsentSaving(true);
    const result = await getLegalService().setConsent("marketing", granted);
    setMarketingConsentSaving(false);
    if (!result.success) {
      setMarketingConsent(!granted);
      toast.error(t("guest.profile.marketingToggleFailed", { defaultValue: "Couldn't save your preference. Try again." }));
    }
  };

  const displayName = profile?.displayName || user?.name || "Guest";
  const avatarText = user?.avatar || displayName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

  const details = [
    { label: t("guest.profile.phone"), value: profile?.phone || user?.phone || "—" },
    { label: t("guest.profile.location"), value: profile?.location || user?.location || "India" },
    { label: t("guest.profile.languages"), value: user?.language || "English" },
    { label: t("guest.profile.memberSince"), value: user?.memberSince || "2025" },
  ];

  const quickLinks = [
    { to: "/messages", icon: MessageCircle, label: t("nav.messages", { defaultValue: "Messages" }) },
    { to: "/provider/verification", icon: ShieldCheck, label: t("nav.verification", { defaultValue: "Verification" }) },
    { to: "/terms", icon: FileText, label: t("nav.termsPolicies", { defaultValue: "Terms & policies" }) },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-14 space-y-6">
        <header>
          <button
            onClick={() => { if (window.history.length > 1) navigate(-1); else navigate("/"); }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors -ml-1 mb-3"
          >
            <ArrowLeft className="w-4 h-4" /> {t("common.back", { defaultValue: "Back" })}
          </button>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight">
            {t("profilePage.title", { defaultValue: "Profile & account" })}
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            {t("profilePage.subtitle", { defaultValue: "Your details, preferences, privacy and data — all in one place." })}
          </p>
        </header>

        {/* Identity */}
        <div className="bg-card rounded-2xl border border-border p-6 sm:p-8">
          <div className="flex items-center gap-4 mb-6">
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
              <p className="text-sm text-muted-foreground truncate">{user?.email || "guest@example.com"}</p>
              <div className="flex items-center gap-1 mt-1">
                <Shield className="w-3.5 h-3.5 text-success" />
                <span className="text-xs text-success font-medium">{t("guest.profile.verifiedMember")}</span>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarBusy}
                  className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Camera className="w-3 h-3" />
                  {profile?.avatarUrl
                    ? t("profilePage.changePhoto", { defaultValue: "Change photo" })
                    : t("profilePage.addPhoto", { defaultValue: "Add photo" })}
                </button>
                {profile?.avatarUrl && (
                  <button
                    onClick={() => void removeAvatar()}
                    disabled={avatarBusy}
                    className="text-xs font-medium text-destructive hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t("profilePage.removePhoto", { defaultValue: "Remove photo" })}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-0">
            {details.map((f) => (
              <div key={f.label} className="flex items-center justify-between py-3.5 border-b border-border last:border-0">
                <span className="text-sm text-muted-foreground">{f.label}</span>
                <span className="text-sm font-medium">{f.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick links */}
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          {quickLinks.map((l, i) => (
            <Link
              key={l.to}
              to={l.to}
              className={`flex items-center gap-3 px-6 py-4 text-sm font-medium hover:bg-muted/50 transition-colors ${i < quickLinks.length - 1 ? "border-b border-border" : ""}`}
            >
              <l.icon className="w-4 h-4 text-primary" />
              <span className="flex-1">{l.label}</span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </Link>
          ))}
        </div>

        {/* Language preference */}
        <div className="bg-card rounded-2xl border border-border p-6 sm:p-8">
          <h4 className="text-sm font-semibold mb-4 flex items-center gap-2"><Globe className="w-4 h-4 text-primary" />{t("guest.profile.languagePref")}</h4>
          <div className="flex flex-wrap gap-2">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => { setLanguage(lang.code); toast.success(t("guest.profile.langChanged", { name: lang.name })); }}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  language === lang.code ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
                }`}
              >
                {lang.nativeName}
              </button>
            ))}
          </div>
        </div>

        {/* Communication preferences */}
        <div className="bg-card rounded-2xl border border-border p-6 sm:p-8">
          <h4 className="text-sm font-semibold mb-4">{t("guest.profile.commPrefs", { defaultValue: "Communication preferences" })}</h4>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{t("guest.profile.marketingToggle", { defaultValue: "Offers and updates" })}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("guest.profile.marketingToggleHint", { defaultValue: "Travel ideas, offers and product updates by email or SMS." })}</p>
            </div>
            <Switch
              checked={marketingConsent}
              disabled={marketingConsentSaving}
              onCheckedChange={toggleMarketingConsent}
              aria-label={t("guest.profile.marketingToggle", { defaultValue: "Offers and updates" })}
            />
          </div>
        </div>

        {/* DSAR export + account deletion (PRIV-002 / LEG-017) */}
        <AccountPrivacyPanel />
      </div>
    </div>
  );
};

export default Profile;
