import { useState } from "react";
import { Link } from "react-router-dom";
import { Mail, ArrowLeft, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

const ForgotPassword = () => {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { resetPassword } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast.error(t("forgotPassword.errEmail")); return; }
    setLoading(true);
    await resetPassword(email);
    setLoading(false);
    setSent(true);
    toast.success(t("forgotPassword.resetSent"));
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {!sent ? (
          <div className="space-y-6 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Mail className="w-7 h-7 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-3xl font-extrabold text-foreground">{t("forgotPassword.title")}</h1>
              <p className="text-muted-foreground mt-2">{t("forgotPassword.subtitle")}</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4 text-left">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} aria-label={t("forgotPassword.emailLabel")} placeholder={t("forgotPassword.emailPlaceholder")}
                  className="w-full pl-10 pr-4 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
              </div>
              <Button type="submit" className="w-full h-12 rounded-xl text-base font-semibold" disabled={loading}>
                {loading ? t("forgotPassword.sending") : t("forgotPassword.send")}
              </Button>
            </form>
            <Link to="/login" className="inline-flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors">
              <ArrowLeft className="w-4 h-4" /> {t("forgotPassword.back")}
            </Link>
          </div>
        ) : (
          <div className="space-y-5 text-center">
            <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>
            <div>
              <h2 className="font-display text-2xl font-bold text-foreground">{t("forgotPassword.sentTitle")}</h2>
              <p className="text-muted-foreground mt-2">{t("forgotPassword.sentSubtitle")} <strong className="text-foreground">{email}</strong></p>
            </div>
            <Button variant="outline" className="rounded-xl" asChild>
              <Link to="/login">{t("forgotPassword.backToLogin")}</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ForgotPassword;
