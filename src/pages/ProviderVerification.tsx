import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Upload, FileCheck, AlertCircle, CheckCircle2, Clock, X, Car, CreditCard, IdCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import BackButton from "@/components/BackButton";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getListingService, getProviderService, getVerificationService } from "@/domains";
import { useLanguage } from "@/contexts/LanguageContext";

// Local mirror of the helper used in TransportDashboard — kept inline rather
// than extracted because it's only used in two files and the listing-type
// signal lives in three different shapes (column, metadata, category).
const TRANSPORT_CATEGORIES = new Set(["driver-auto", "driver-cab", "driver-quote", "auto", "cab", "van", "bike", "tempo"]);
const isTransportListing = (l: any) =>
  l?.listing_type === "transport"
  || l?.metadata?.listingType === "transport"
  || TRANSPORT_CATEGORIES.has(l?.category);

type DocType = "aadhaar" | "driving_license" | "pan_card" | "voter_id" | "passport";

interface DocRequirement {
  type: DocType;
  label: string;
  labelKey: string;
  description: string;
  descriptionKey: string;
  icon: React.ReactNode;
  required: boolean;
  forServiceTypes?: string[];
}

const docRequirements: DocRequirement[] = [
  { type: "aadhaar", label: "Aadhaar Card", labelKey: "providerVerify.docAadhaarLabel", description: "Government-issued identity card (mandatory for all providers)", descriptionKey: "providerVerify.docAadhaarDesc", icon: <IdCard className="w-5 h-5" />, required: true },
  { type: "driving_license", label: "Driving License", labelKey: "providerVerify.docLicenseLabel", description: "Required for drivers and transport service providers", descriptionKey: "providerVerify.docLicenseDesc", icon: <Car className="w-5 h-5" />, required: false, forServiceTypes: ["Auto / Cab Driver", "Delivery Help"] },
  { type: "pan_card", label: "PAN Card", labelKey: "providerVerify.docPanLabel", description: "Tax identification (recommended for all providers)", descriptionKey: "providerVerify.docPanDesc", icon: <CreditCard className="w-5 h-5" />, required: false },
  { type: "voter_id", label: "Voter ID", labelKey: "providerVerify.docVoterLabel", description: "Alternative government ID for identity verification", descriptionKey: "providerVerify.docVoterDesc", icon: <IdCard className="w-5 h-5" />, required: false },
  { type: "passport", label: "Passport", labelKey: "providerVerify.docPassportLabel", description: "International identity document", descriptionKey: "providerVerify.docPassportDesc", icon: <IdCard className="w-5 h-5" />, required: false },
];

const statusConfig = {
  pending: { color: "text-yellow-600 bg-yellow-50 border-yellow-200", icon: <Clock className="w-4 h-4" />, label: "Under Review", labelKey: "providerVerify.statusUnderReview" },
  approved: { color: "text-success bg-success/5 border-success/20", icon: <CheckCircle2 className="w-4 h-4" />, label: "Approved", labelKey: "providerVerify.statusApproved" },
  rejected: { color: "text-destructive bg-destructive/5 border-destructive/20", icon: <AlertCircle className="w-4 h-4" />, label: "Rejected", labelKey: "providerVerify.statusRejected" },
};

const ProviderVerification = () => {
  const { t } = useLanguage();
  const { user, refreshVerification } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Fetch provider profile
  const { data: profile } = useQuery({
    queryKey: ["provider-profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const result = await getProviderService().getProfileByUserId(user.id);
      if (!result.success) throw new Error(result.error || "Failed to load provider profile");
      return result.data;
    },
    enabled: !!user?.id,
  });

  // Fetch existing documents (per-user, not per-provider)
  const { data: documents = [] } = useQuery({
    queryKey: ["verification-documents", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const result = await getVerificationService().getDocuments();
      if (!result.success) throw new Error(result.error || "Failed to load documents");
      return result.data || [];
    },
    enabled: !!user?.id,
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, docType, docNumber }: { file: File; docType: DocType; docNumber?: string }) => {
      if (!user?.id) throw new Error("Not authenticated");
      const result = await getVerificationService().uploadDocument({
        userId: user.id,
        documentType: docType,
        documentNumber: docNumber,
        file,
      });
      if (!result.success) throw new Error(result.error || "Upload failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["verification-documents"] });
      toast.success(t("providerVerify.uploadSuccess", { defaultValue: "Document uploaded successfully! Under review." }));
      setUploading(null);
      // KYC verification runs async on the backend (`void
      // processKycVerification(...)` in verification.service.ts) and the
      // mock provider auto-approves moments later. Poll the docs query and
      // user verification status a few times so the UI flips from
      // "pending" → "verified" without the user needing to refresh. Three
      // attempts spaced over ~3s comfortably covers the mock latency and
      // any small DB round-trip; production real-KYC would still take
      // hours and the user would see "pending" until then, which is
      // correct.
      [400, 1200, 3000].forEach((ms) => {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["verification-documents"] });
          void refreshVerification();
        }, ms);
      });
    },
    onError: (err: Error) => {
      toast.error(t("providerVerify.uploadFailedReason", { defaultValue: "Upload failed: {{reason}}", reason: err.message }));
      setUploading(null);
    },
  });

  const handleFileSelect = (docType: DocType) => {
    const input = fileInputRefs.current[docType];
    if (input) input.click();
  };

  const handleFileChange = (docType: DocType, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error(t("providerVerify.fileTooLarge", { defaultValue: "File must be under 5MB" }));
      return;
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      toast.error(t("providerVerify.fileTypeInvalid", { defaultValue: "Only JPG, PNG, WebP, or PDF files accepted" }));
      return;
    }

    setUploading(docType);
    uploadMutation.mutate({ file, docType });
  };

  const getDocStatus = (docType: DocType) => {
    return documents.find((d: any) => (d.document_type || d.documentType) === docType);
  };

  // Whether this user needs a Driving Licence in addition to Aadhaar.
  // Sourced from their actual listings (does any have listing_type=transport?)
  // rather than the legacy provider_profile.service_categories field, which
  // many users won't have populated after the KYC-on-users refactor.
  // Users with no listings yet default to "Aadhaar only"; if they later
  // create a transport listing, the licence row becomes required.
  const { data: myListings = [] } = useQuery({
    queryKey: ["my-listings", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      if (!user?.id) return [];
      const result = await getListingService().getByUserId(String(user.id));
      if (!result.success) return [];
      return result.data || [];
    },
  });
  const needsDrivingLicense = myListings.some(isTransportListing);

  const relevantDocs = docRequirements.filter((doc) => {
    if (doc.required) return true;
    if (doc.forServiceTypes && needsDrivingLicense) return true;
    return true; // Show all optional docs too
  });

  const overallStatus = user?.verificationStatus || "pending";
  const approvedCount = documents.filter((d: any) => d.status === "approved").length;
  const hasAadhaar = documents.some((d: any) => (d.document_type || d.documentType) === "aadhaar" && d.status === "approved");
  const hasLicense = documents.some((d: any) => (d.document_type || d.documentType) === "driving_license" && d.status === "approved");

  // Build the "what's still required" list shown in the status card body.
  // We list only the docs that are mandatory for this user's role and not
  // yet approved, naming them explicitly (e.g. "Aadhaar Card") so the user
  // doesn't have to scan the section below to know what's missing.
  type RequiredItem = { label: string; status: "missing" | "pending" | "rejected" };
  const requiredOutstanding: RequiredItem[] = [];
  const docState = (type: DocType) => documents.find((d: any) => (d.document_type || d.documentType) === type);
  const aadhaarState = docState("aadhaar");
  if (!hasAadhaar) {
    requiredOutstanding.push({
      label: t("providerVerify.docAadhaarLabel", { defaultValue: "Aadhaar Card" }),
      status: aadhaarState?.status === "rejected" ? "rejected"
        : aadhaarState?.status === "pending" ? "pending"
        : "missing",
    });
  }
  if (needsDrivingLicense && !hasLicense) {
    const licenseState = docState("driving_license");
    requiredOutstanding.push({
      label: t("providerVerify.docLicenseLabel", { defaultValue: "Driving License" }),
      status: licenseState?.status === "rejected" ? "rejected"
        : licenseState?.status === "pending" ? "pending"
        : "missing",
    });
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Shield className="w-16 h-16 text-muted-foreground/30 mx-auto" />
          <h2 className="font-display text-2xl font-bold">{t("providerVerify.loginRequiredTitle", { defaultValue: "Login Required" })}</h2>
          <p className="text-muted-foreground">{t("providerVerify.loginRequiredBody", { defaultValue: "You need to be logged in to verify your provider account." })}</p>
          <Button onClick={() => navigate("/login")} className="rounded-xl">{t("providerVerify.goToLogin", { defaultValue: "Go to Login" })}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary/5 to-secondary/5 py-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <BackButton className="mb-3" />
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-foreground">{t("providerVerify.pageTitle", { defaultValue: "Provider Verification" })}</h1>
              <p className="text-sm text-muted-foreground">{t("providerVerify.pageSubtitle", { defaultValue: "Verify your identity to build trust with customers" })}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Overall Status Card */}
        <div className={`rounded-2xl border p-6 ${
          overallStatus === "verified" ? "bg-success/5 border-success/20" :
          overallStatus === "rejected" ? "bg-destructive/5 border-destructive/20" :
          "bg-yellow-50 border-yellow-200"
        }`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              {overallStatus === "verified" ? <CheckCircle2 className="w-8 h-8 text-success" /> :
               overallStatus === "rejected" ? <AlertCircle className="w-8 h-8 text-destructive" /> :
               <Clock className="w-8 h-8 text-yellow-600" />}
              <div>
                <h2 className="font-display font-bold text-lg">
                  {overallStatus === "verified" ? t("providerVerify.statusVerifiedProvider", { defaultValue: "Verified Provider ✓" }) :
                   overallStatus === "rejected" ? t("providerVerify.statusNeedsAttention", { defaultValue: "Verification Needs Attention" }) :
                   t("providerVerify.statusPending", { defaultValue: "Verification Pending" })}
                </h2>
                {overallStatus === "verified" ? (
                  <p className="text-sm text-muted-foreground">
                    {t("providerVerify.docsApprovedVerified", { defaultValue: "{{count}} document(s) approved — your account is verified.", count: approvedCount })}
                  </p>
                ) : requiredOutstanding.length > 0 ? (
                  <div className="text-sm text-muted-foreground space-y-0.5 mt-0.5">
                    <p className="font-medium text-foreground/80">{t("providerVerify.stillRequired", { defaultValue: "Still required:" })}</p>
                    <ul className="space-y-0.5">
                      {requiredOutstanding.map((item) => (
                        <li key={item.label} className="flex items-center gap-1.5">
                          <span className={
                            item.status === "rejected" ? "text-destructive" :
                            item.status === "pending" ? "text-yellow-700" :
                            "text-muted-foreground"
                          }>•</span>
                          <span>{item.label}</span>
                          <span className="text-xs">
                            {item.status === "rejected" ? t("providerVerify.itemRejected", { defaultValue: "(rejected — please re-upload)" }) :
                             item.status === "pending" ? t("providerVerify.itemUnderReview", { defaultValue: "(under review)" }) :
                             t("providerVerify.itemNotUploaded", { defaultValue: "(not uploaded)" })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("providerVerify.docsApprovedFinishing", { defaultValue: "{{count}} document(s) approved — finishing review.", count: approvedCount })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="px-3 py-1.5 rounded-full font-semibold bg-card border border-border">
                {hasAadhaar ? t("providerVerify.idVerified", { defaultValue: "✓ ID Verified" }) : t("providerVerify.idPending", { defaultValue: "⏳ ID Pending" })}
              </span>
              {needsDrivingLicense && (
                <span className="px-3 py-1.5 rounded-full font-semibold bg-card border border-border">
                  {hasLicense ? t("providerVerify.licenseVerified", { defaultValue: "✓ License Verified" }) : t("providerVerify.licensePending", { defaultValue: "⏳ License Pending" })}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Document Upload Cards */}
        <div className="space-y-4">
          <h3 className="font-display font-semibold text-lg">{t("providerVerify.requiredDocuments", { defaultValue: "Required Documents" })}</h3>

          {relevantDocs.map((doc) => {
            const existing = getDocStatus(doc.type);
            const status = existing ? statusConfig[existing.status as keyof typeof statusConfig] : null;
            const isRequired = doc.required || (doc.forServiceTypes && needsDrivingLicense);

            return (
              <div key={doc.type} className="bg-card rounded-2xl border border-border/60 p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                      {doc.icon}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-display font-semibold text-foreground">{t(doc.labelKey, { defaultValue: doc.label })}</h4>
                        {isRequired && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-destructive bg-destructive/10 px-2 py-0.5 rounded-full">{t("providerVerify.requiredBadge", { defaultValue: "Required" })}</span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{t(doc.descriptionKey, { defaultValue: doc.description })}</p>

                      {existing?.status === "rejected" && (existing as any).rejection_reason && (
                        <div className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
                          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                          <span>{t("providerVerify.rejectionReason", { defaultValue: "Reason: {{reason}}", reason: (existing as any).rejection_reason })}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0">
                    {status ? (
                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${status.color}`}>
                        {status.icon}
                        {t(status.labelKey, { defaultValue: status.label })}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="rounded-xl text-xs font-semibold bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 active:shadow-sm transition-all duration-200"
                        onClick={() => handleFileSelect(doc.type)}
                        disabled={uploading === doc.type}
                      >
                        {uploading === doc.type ? (
                          <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 animate-spin" /> {t("providerVerify.uploading", { defaultValue: "Uploading..." })}</span>
                        ) : (
                          <span className="flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" /> {t("providerVerify.upload", { defaultValue: "Upload" })}</span>
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Re-upload for rejected docs */}
                {existing?.status === "rejected" && (
                  <div className="mt-4 pt-4 border-t border-border/50">
                    <Button
                      size="sm"
                      className="rounded-xl text-xs font-semibold bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 active:shadow-sm transition-all duration-200"
                      onClick={() => handleFileSelect(doc.type)}
                      disabled={uploading === doc.type}
                    >
                      <Upload className="w-3.5 h-3.5 mr-1.5" /> {t("providerVerify.reuploadDocument", { defaultValue: "Re-upload Document" })}
                    </Button>
                  </div>
                )}

                <input
                  ref={(el) => { fileInputRefs.current[doc.type] = el; }}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  onChange={(e) => handleFileChange(doc.type, e)}
                />
              </div>
            );
          })}
        </div>

        {/* Guidelines */}
        <div className="bg-muted/50 rounded-2xl border border-border/60 p-6">
          <h3 className="font-display font-semibold text-lg mb-4 flex items-center gap-2">
            <FileCheck className="w-5 h-5 text-primary" />
            {t("providerVerify.uploadGuidelines", { defaultValue: "Upload Guidelines" })}
          </h3>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" /> {t("providerVerify.guidelineClear", { defaultValue: "Documents must be clear, legible scans or photos" })}</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" /> {t("providerVerify.guidelineFormats", { defaultValue: "Accepted formats: JPG, PNG, WebP, or PDF (max 5MB)" })}</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" /> {t("providerVerify.guidelineAadhaar", { defaultValue: "Aadhaar / Government ID is mandatory for all providers" })}</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" /> {t("providerVerify.guidelineLicense", { defaultValue: "Driving License is mandatory for transport & delivery providers" })}</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" /> {t("providerVerify.guidelineTimeframe", { defaultValue: "Verification typically completes within 24-48 hours" })}</li>
            <li className="flex items-start gap-2"><AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" /> {t("providerVerify.guidelineTampered", { defaultValue: "Tampered or unclear documents will be rejected" })}</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default ProviderVerification;
