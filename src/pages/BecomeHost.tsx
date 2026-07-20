import { Link } from "react-router-dom";
import { Check, Building, Globe, TrendingUp, Shield, Star, Users, ChevronRight, ArrowRight, MapPin, BarChart3, Calendar, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import BackButton from "@/components/BackButton";
import { useLanguage } from "@/contexts/LanguageContext";

const BecomeHost = () => {
  const { t } = useLanguage();

  const steps = [
    { num: "1", title: t("host.step1Title"), desc: t("host.step1Desc") },
    { num: "2", title: t("host.step2Title"), desc: t("host.step2Desc") },
    { num: "3", title: t("host.step3Title"), desc: t("host.step3Desc") },
  ];

  const benefits = [
    { icon: TrendingUp, title: t("host.b1Title"), desc: t("host.b1Desc") },
    { icon: Globe, title: t("host.b2Title"), desc: t("host.b2Desc") },
    { icon: Shield, title: t("host.b3Title"), desc: t("host.b3Desc") },
    { icon: Users, title: t("host.b4Title"), desc: t("host.b4Desc") },
    { icon: Star, title: t("host.b5Title"), desc: t("host.b5Desc") },
    { icon: Settings, title: t("host.b6Title"), desc: t("host.b6Desc") },
  ];

  const earningPotential = [
    { location: t("host.earnings.touristTowns"), range: "₹25K–50K/mo", occupancy: "70-85%" },
    { location: t("host.earnings.tier2"), range: "₹15K–30K/mo", occupancy: "55-70%" },
    { location: t("host.earnings.smallTowns"), range: "₹8K–18K/mo", occupancy: "40-60%" },
  ];

  const testimonials = [
    { name: "Mohammed Ismail", location: "Hampi, KA", text: t("host.testimonials.t1Text"), avatar: "MI" },
    { name: "Karthik R", location: "Kumbakonam, TN", text: t("host.testimonials.t2Text"), avatar: "KR" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
        <BackButton />
      </div>
      {/* Hero */}
      <section className="bg-gradient-to-br from-primary/5 via-background to-secondary/5 py-12 lg:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-sm font-medium text-primary mb-6">
            <Building className="w-4 h-4" /> {t("host.hero.badge")}
          </div>
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mb-4">
            {t("host.hero.title1")} <span className="text-primary">{t("host.hero.title2")}</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-6">
            {t("host.hero.subtitle")}
          </p>
          {/* Location-based earning teaser */}
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-success/8 rounded-full text-sm font-medium text-success mb-8 border border-success/15">
            <MapPin className="w-4 h-4" />
            {t("host.hero.earningTeaser")}
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button size="lg" className="rounded-full font-semibold shadow-lg shadow-primary/20" asChild>
              <Link to="/signup">{t("host.hero.ctaPrimary")} <ArrowRight className="w-4 h-4 ml-1" /></Link>
            </Button>
            <Button size="lg" variant="outline" className="rounded-full font-semibold bg-gradient-to-r from-accent/10 to-primary/10 border-accent/30 hover:border-accent/50" asChild>
              <Link to="/onboarding?type=host">{t("host.hero.ctaAi")}</Link>
            </Button>
            <Button size="lg" variant="outline" className="rounded-full font-semibold" asChild>
              <Link to="/login">{t("host.hero.ctaExisting")}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h2 className="font-display text-2xl sm:text-3xl font-bold text-center mb-12">{t("host.steps.title")}</h2>
        <div className="grid sm:grid-cols-3 gap-8">
          {steps.map((s, i) => (
            <div key={s.num} className="text-center relative">
              {i < steps.length - 1 && <div className="hidden sm:block absolute top-8 -right-4 w-8 h-px bg-border" />}
              <div className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-4 text-xl font-bold font-display shadow-lg shadow-primary/20">{s.num}</div>
              <h3 className="font-display font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Earning Potential by Location */}
      <section className="bg-gradient-to-r from-primary/5 to-secondary/5 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-xs font-bold uppercase tracking-wider text-primary mb-3">
              <BarChart3 className="w-3.5 h-3.5" /> {t("host.earnings.badge")}
            </div>
            <h2 className="font-display text-2xl sm:text-3xl font-bold">{t("host.earnings.title")}</h2>
            <p className="text-muted-foreground mt-2 max-w-lg mx-auto text-sm">{t("host.earnings.subtitle")}</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {earningPotential.map((e) => (
              <div key={e.location} className="bg-card rounded-2xl border border-border p-6 text-center hover:shadow-md transition-all">
                <MapPin className="w-5 h-5 text-primary mx-auto mb-2" />
                <h3 className="font-display font-semibold text-sm mb-1">{e.location}</h3>
                <p className="text-2xl font-bold text-primary">{e.range}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("host.earnings.occupancyLabel", { range: e.occupancy })}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-center mb-12">{t("host.benefits.title")}</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {benefits.map((b, i) => (
              <div key={i} className="p-6 bg-card rounded-2xl border border-border hover:shadow-md transition-all">
                <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4"><b.icon className="w-6 h-6" /></div>
                <h3 className="font-display font-semibold mb-2">{b.title}</h3>
                <p className="text-sm text-muted-foreground">{b.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid lg:grid-cols-2 gap-10">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl font-bold mb-4">{t("host.revenue.title")}</h2>
            <p className="text-muted-foreground mb-8">{t("host.revenue.subtitle")}</p>
            <div className="grid grid-cols-3 gap-6">
              {[{ label: t("host.stats.activeHosts"), value: "2,500+" }, { label: t("host.stats.avgEarning"), value: "₹18K/mo" }, { label: t("host.stats.cities"), value: "50+" }].map((s) => (
                <div key={s.label} className="bg-card rounded-xl border border-border p-4 text-center">
                  <div className="text-xl font-bold text-primary">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="font-display font-semibold">{t("host.testimonials.heading")}</h3>
            {testimonials.map((tm, i) => (
              <div key={i} className="p-5 bg-card rounded-2xl border border-border">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">{tm.avatar}</div>
                  <div><p className="font-medium text-sm">{tm.name}</p><p className="text-xs text-muted-foreground">{tm.location}</p></div>
                </div>
                <p className="text-sm text-muted-foreground italic">"{tm.text}"</p>
                <div className="flex gap-0.5 mt-2">{[1,2,3,4,5].map(n => <Star key={n} className="w-3.5 h-3.5 fill-secondary text-secondary" />)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-gradient-to-r from-primary to-primary/80 text-primary-foreground rounded-3xl p-10 lg:p-16 text-center">
          <h2 className="font-display text-3xl font-bold mb-4">{t("host.cta.title")}</h2>
          <p className="text-lg opacity-80 mb-8 max-w-xl mx-auto">{t("host.cta.subtitle")}</p>
          <Button size="lg" className="rounded-full bg-primary-foreground text-primary hover:bg-primary-foreground/90 font-semibold shadow-lg" asChild>
            <Link to="/signup">{t("host.cta.button")} <ArrowRight className="w-4 h-4 ml-1" /></Link>
          </Button>
        </div>
      </section>
    </div>
  );
};

export default BecomeHost;
