import { Shield, Users, Camera, KeyRound, MapPin, Phone, Heart, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import BackButton from "@/components/BackButton";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getSafetyService } from "@/domains";
import { useLanguage } from "@/contexts/LanguageContext";

const SafetyCenter = () => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();

  const safetyTips = [
    { icon: Users, title: t("safetyCenter.tip1Title", { defaultValue: "Have someone present" }), desc: t("safetyCenter.tip1Desc", { defaultValue: "Especially for in-home services, ensure another person is present during the appointment." }), category: t("safetyCenter.forCustomers", { defaultValue: "For Customers" }) },
    { icon: Camera, title: t("safetyCenter.tip2Title", { defaultValue: "Verify provider identity" }), desc: t("safetyCenter.tip2Desc", { defaultValue: "Check the provider's ID badge and match it with the app profile before allowing entry." }), category: t("safetyCenter.forCustomers", { defaultValue: "For Customers" }) },
    { icon: KeyRound, title: t("safetyCenter.tip3Title", { defaultValue: "Use OTP verification" }), desc: t("safetyCenter.tip3Desc", { defaultValue: "Always verify the one-time code shared between you and the service provider." }), category: t("safetyCenter.forEveryone", { defaultValue: "For Everyone" }) },
    { icon: MapPin, title: t("safetyCenter.tip4Title", { defaultValue: "Share your live location" }), desc: t("safetyCenter.tip4Desc", { defaultValue: "Enable location sharing with trusted contacts during service visits." }), category: t("safetyCenter.forProviders", { defaultValue: "For Providers" }) },
    { icon: Phone, title: t("safetyCenter.tip5Title", { defaultValue: "Keep emergency contacts ready" }), desc: t("safetyCenter.tip5Desc", { defaultValue: "Add emergency contacts in the app for quick SOS alerts." }), category: t("safetyCenter.forEveryone", { defaultValue: "For Everyone" }) },
    { icon: Shield, title: t("safetyCenter.tip6Title", { defaultValue: "Trust your instincts" }), desc: t("safetyCenter.tip6Desc", { defaultValue: "If something feels wrong, use the SOS button or leave the situation immediately." }), category: t("safetyCenter.forEveryone", { defaultValue: "For Everyone" }) },
  ];

  const emergencyContacts = [
    { name: t("safetyCenter.police", { defaultValue: "Police" }), number: "100", icon: Shield },
    { name: t("safetyCenter.womenHelpline", { defaultValue: "Women Helpline" }), number: "1091", icon: Heart },
    { name: t("safetyCenter.emergency", { defaultValue: "Emergency" }), number: "112", icon: Phone },
    { name: t("safetyCenter.ambulance", { defaultValue: "Ambulance" }), number: "108", icon: AlertTriangle },
  ];

  const { data: alerts = [] } = useQuery({
    queryKey: ["safety-alerts", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const result = await getSafetyService().getUserAlerts(user.id);
      if (!result.success) throw new Error(result.error || t("safetyCenter.failedLoadAlerts", { defaultValue: "Failed to load safety alerts" }));
      return (result.data || []).slice(0, 10);
    },
    enabled: !!user?.id,
  });

  const statusBadge = (status: string) => {
    const config: Record<string, { color: string; label: string }> = {
      open: { color: "text-yellow-600 bg-yellow-50 border-yellow-200", label: t("safetyCenter.statusOpen", { defaultValue: "Open" }) },
      acknowledged: { color: "text-primary bg-primary/5 border-primary/20", label: t("safetyCenter.statusAcknowledged", { defaultValue: "Acknowledged" }) },
      resolved: { color: "text-success bg-success/5 border-success/20", label: t("safetyCenter.statusResolved", { defaultValue: "Resolved" }) },
    };
    const c = config[status] || config.open;
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${c.color}`}>{c.label}</span>;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-gradient-to-r from-destructive/5 to-primary/5 py-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <BackButton className="mb-3" />
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-foreground">{t("safetyCenter.title", { defaultValue: "Safety Center" })}</h1>
              <p className="text-sm text-muted-foreground">{t("safetyCenter.subtitle", { defaultValue: "Your safety is our top priority" })}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
        {/* Emergency Quick Dial */}
        <div className="bg-destructive/5 border border-destructive/20 rounded-2xl p-6">
          <h2 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
            <Phone className="w-5 h-5 text-destructive" /> {t("safetyCenter.emergencyContacts", { defaultValue: "Emergency Contacts" })}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {emergencyContacts.map((contact) => (
              <a
                key={contact.number}
                href={`tel:${contact.number}`}
                className="flex flex-col items-center gap-2 p-4 bg-card rounded-xl border border-border hover:border-destructive/30 transition-colors text-center group"
              >
                <div className="w-10 h-10 rounded-full bg-destructive/10 text-destructive flex items-center justify-center group-hover:bg-destructive group-hover:text-destructive-foreground transition-colors">
                  <contact.icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-semibold">{contact.name}</p>
                  <p className="text-lg font-bold font-mono text-destructive">{contact.number}</p>
                </div>
              </a>
            ))}
          </div>
        </div>

        {/* Safety Guidelines */}
        <div>
          <h2 className="font-display font-bold text-lg mb-4">{t("safetyCenter.guidelines", { defaultValue: "Safety Guidelines" })}</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {safetyTips.map((tip, i) => (
              <div key={i} className="p-5 bg-card rounded-2xl border border-border/50 hover:border-primary/20 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <tip.icon className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                    {tip.category}
                  </span>
                </div>
                <h3 className="font-display font-semibold text-sm mb-1">{tip.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{tip.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Safety Features */}
        <div className="bg-gradient-to-br from-primary/5 to-success/5 rounded-2xl border border-border/50 p-6">
          <h2 className="font-display font-bold text-lg mb-4">{t("safetyCenter.builtInFeatures", { defaultValue: "Built-in Safety Features" })}</h2>
          <div className="space-y-4">
            {[
              { icon: Shield, title: t("safetyCenter.feature1Title", { defaultValue: "SOS Emergency Button" }), desc: t("safetyCenter.feature1Desc", { defaultValue: "One-tap emergency alert that shares your live location with emergency contacts and our safety team." }) },
              { icon: KeyRound, title: t("safetyCenter.feature2Title", { defaultValue: "OTP Verification" }), desc: t("safetyCenter.feature2Desc", { defaultValue: "Unique one-time codes to verify both the provider and customer before starting any service." }) },
              { icon: Users, title: t("safetyCenter.feature3Title", { defaultValue: "Companion Check" }), desc: t("safetyCenter.feature3Desc", { defaultValue: "For in-home services, we prompt users to confirm if another person is present — especially for solo appointments." }) },
              { icon: Camera, title: t("safetyCenter.feature4Title", { defaultValue: "Identity Verification" }), desc: t("safetyCenter.feature4Desc", { defaultValue: "Providers undergo mandatory ID verification. Customers can verify provider identity at arrival." }) },
              { icon: MapPin, title: t("safetyCenter.feature5Title", { defaultValue: "Real-time Location Sharing" }), desc: t("safetyCenter.feature5Desc", { defaultValue: "Share your live location with trusted contacts during service visits for added security." }) },
            ].map((feature, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                  <feature.icon className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="font-semibold text-sm">{feature.title}</h4>
                  <p className="text-xs text-muted-foreground">{feature.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Alert History */}
        {user && alerts.length > 0 && (
          <div>
            <h2 className="font-display font-bold text-lg mb-4">{t("safetyCenter.history", { defaultValue: "Your Safety History" })}</h2>
            <div className="space-y-3">
              {alerts.map((alert: any) => (
                <div key={alert.id} className="p-4 bg-card rounded-xl border border-border/50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      alert.alertType === "sos" ? "bg-destructive/10 text-destructive" : "bg-yellow-100 text-yellow-700"
                    }`}>
                      {alert.alertType === "sos" ? <Phone className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold capitalize">{alert.alertType.replace("_", " ")}</p>
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {new Date(alert.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  {statusBadge(alert.status || "open")}
                </div>
              ))}
            </div>
          </div>
        )}

        {!user && (
          <div className="text-center py-6 space-y-3">
            <p className="text-muted-foreground text-sm">{t("safetyCenter.loginPrompt", { defaultValue: "Log in to access personalized safety features and history." })}</p>
            <Button onClick={() => navigate("/login")} className="rounded-xl">{t("safetyCenter.goToLogin", { defaultValue: "Go to Login" })}</Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SafetyCenter;
