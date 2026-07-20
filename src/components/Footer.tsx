import { Link } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { MapPin, Phone, Mail, Globe, ArrowUpRight } from "lucide-react";
import { SUPPORT_EMAIL, SUPPORT_PHONE } from "@/lib/legal";

const Footer = () => {
  const { t } = useLanguage();

  return (
    <footer className="bg-foreground text-background relative overflow-hidden">
      {/* Accent gradient */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-20">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12">
          <div className="space-y-5 lg:col-span-1">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-extrabold text-sm">IS</span>
              </div>
              <span className="font-display font-extrabold text-xl">
                Ista<span className="text-primary">Seva</span>
              </span>
            </div>
            <p className="text-sm opacity-60 leading-relaxed max-w-xs">
              {t("footer.tagline")}
            </p>
            <div className="space-y-2 text-sm opacity-60">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 shrink-0" /> Bengaluru, India
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 shrink-0" /> <a href={`tel:${SUPPORT_PHONE.replace(/\s+/g, "")}`} className="hover:underline">{SUPPORT_PHONE}</a>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 shrink-0" /> <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:underline">{SUPPORT_EMAIL}</a>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h4 className="font-display font-bold text-sm uppercase tracking-wider opacity-80">{t("footer.sections.travelers")}</h4>
            <ul className="space-y-2.5 text-sm opacity-60">
              {[
                { to: "/explore", label: t("exploreStays") },
                { to: "/services", label: t("services") },
                { to: "/bookings", label: t("footer.links.myBookings") },
                { to: "/explore?type=homestay", label: t("footer.links.homestays") },
                { to: "/explore?type=hotel", label: t("footer.links.budgetHotels") },
              ].map((l) => (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    className="hover:text-primary hover:opacity-100 transition-all inline-flex items-center gap-1"
                  >
                    {l.label} <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-display font-bold text-sm uppercase tracking-wider opacity-80">{t("footer.sections.partners")}</h4>
            <ul className="space-y-2.5 text-sm opacity-60">
              {[
                { to: "/become-host", label: t("becomeHost") },
                { to: "/become-provider", label: t("becomePartner") },
                { to: "/dashboard/host", label: t("footer.links.hostDashboard") },
                { to: "/dashboard/provider", label: t("footer.links.partnerDashboard") },
              ].map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="hover:text-primary hover:opacity-100 transition-all">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-display font-bold text-sm uppercase tracking-wider opacity-80">{t("footer.sections.company")}</h4>
            <ul className="space-y-2.5 text-sm opacity-60">
              {[
                { to: "/about", label: t("about") },
                { to: "/contact", label: t("contact") },
                { to: "/privacy", label: t("footer.links.privacy") },
                { to: "/terms", label: t("footer.links.terms") },
                { to: "/refunds", label: t("footer.links.refunds", { defaultValue: "Cancellation & Refunds" }) },
                { to: "/grievance", label: t("footer.links.grievance", { defaultValue: "Grievance Redressal" }) },
                { to: "/delete-account", label: t("footer.links.deleteAccount", { defaultValue: "Delete Account" }) },
                { to: "/licenses", label: t("footer.links.licenses", { defaultValue: "Open-source Licences" }) },
              ].map((l) => (
                <li key={l.label}>
                  <Link to={l.to} className="hover:text-primary hover:opacity-100 transition-all">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-background/10 mt-14 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm opacity-40">{t("footer.copyright")}</p>
          <div className="flex items-center gap-2 text-xs opacity-40">
            <Globe className="w-3.5 h-3.5" />
            <span>EN • हिन्दी • తెలుగు • தமிழ் • ಕನ್ನಡ • മലയാളം • मराठी</span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
