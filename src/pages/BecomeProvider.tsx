import { Link } from "react-router-dom";
import { Sparkles, TrendingUp, Shield, Clock, Users, MapPin, ArrowRight, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import BackButton from "@/components/BackButton";
import { useLanguage } from "@/contexts/LanguageContext";

const BecomeProvider = () => {
  const { t } = useLanguage();

  const steps = [
    { num: "1", title: t("partner.step1Title"), desc: t("partner.step1Desc") },
    { num: "2", title: t("partner.step2Title"), desc: t("partner.step2Desc") },
    { num: "3", title: t("partner.step3Title"), desc: t("partner.step3Desc") },
  ];

  const benefits = [
    { icon: Clock, title: t("partner.b1Title"), desc: t("partner.b1Desc") },
    { icon: TrendingUp, title: t("partner.b2Title"), desc: t("partner.b2Desc") },
    { icon: MapPin, title: t("partner.b3Title"), desc: t("partner.b3Desc") },
    { icon: Shield, title: t("partner.b4Title"), desc: t("partner.b4Desc") },
    { icon: Users, title: t("partner.b5Title"), desc: t("partner.b5Desc") },
    { icon: Sparkles, title: t("partner.b6Title"), desc: t("partner.b6Desc") },
  ];

  const testimonials = [
    { name: "Rajendra Patil", location: "Pune, MH", text: t("partner.testimonials.t1Text"), avatar: "RP" },
    { name: "Prakash Kumar", location: "Varanasi, UP", text: t("partner.testimonials.t2Text"), avatar: "PK" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
        <BackButton />
      </div>
      <section className="bg-gradient-to-br from-secondary/10 via-background to-accent/5 py-12 lg:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-secondary/20 rounded-full text-sm font-medium text-foreground mb-6">
            <Sparkles className="w-4 h-4" /> {t("partner.hero.badge")}
          </div>
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            {t("partner.hero.title1")} <span className="text-primary">{t("partner.hero.title2")}</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
            {t("partner.hero.subtitle")}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button size="lg" className="rounded-full font-semibold shadow-lg shadow-primary/20" asChild>
              <Link to="/signup">{t("partner.hero.ctaPrimary")} <ArrowRight className="w-4 h-4 ml-1" /></Link>
            </Button>
            <Button size="lg" variant="outline" className="rounded-full font-semibold bg-gradient-to-r from-accent/10 to-secondary/10 border-accent/30 hover:border-accent/50" asChild>
              <Link to="/onboarding?type=service">{t("partner.hero.ctaAi")}</Link>
            </Button>
            <Button size="lg" variant="outline" className="rounded-full font-semibold" asChild>
              <Link to="/login">{t("partner.hero.ctaExisting")}</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h2 className="font-display text-2xl sm:text-3xl font-bold text-center mb-12">{t("partner.steps.title")}</h2>
        <div className="grid sm:grid-cols-3 gap-8">
          {steps.map((s, i) => (
            <div key={s.num} className="text-center relative">
              {i < steps.length - 1 && <div className="hidden sm:block absolute top-8 -right-4 w-8 h-px bg-border" />}
              <div className="w-16 h-16 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center mx-auto mb-4 text-xl font-bold font-display shadow-lg shadow-secondary/20">{s.num}</div>
              <h3 className="font-display font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-muted/50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-center mb-12">{t("partner.benefits.title")}</h2>
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

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid lg:grid-cols-2 gap-10">
          <div>
            <h2 className="font-display text-2xl font-bold mb-4">{t("partner.success.title")}</h2>
            <div className="grid grid-cols-3 gap-4 mb-6">
              {[{ label: t("partner.stats.activePartners"), value: "5,000+" }, { label: t("partner.stats.avgEarning"), value: "₹22K/mo" }, { label: t("partner.stats.serviceAreas"), value: "50+" }].map((s) => (
                <div key={s.label} className="bg-card rounded-xl border border-border p-4 text-center">
                  <div className="text-xl font-bold text-primary">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="font-display font-semibold">{t("partner.testimonials.heading")}</h3>
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

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-gradient-to-r from-secondary to-secondary/80 text-secondary-foreground rounded-3xl p-10 lg:p-16 text-center">
          <h2 className="font-display text-3xl font-bold mb-4">{t("partner.cta.title")}</h2>
          <p className="text-lg opacity-80 mb-8 max-w-xl mx-auto">{t("partner.cta.subtitle")}</p>
          <Button size="lg" className="rounded-full bg-secondary-foreground text-secondary hover:bg-secondary-foreground/90 font-semibold shadow-lg" asChild>
            <Link to="/signup">{t("partner.cta.button")} <ArrowRight className="w-4 h-4 ml-1" /></Link>
          </Button>
        </div>
      </section>
    </div>
  );
};

export default BecomeProvider;
