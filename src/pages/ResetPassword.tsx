import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Lock, Eye, EyeOff, ArrowLeft, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

type Phase = "verifying" | "invalid" | "ready" | "done";

const MIN_PASSWORD_LENGTH = 6;

const ResetPassword = () => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { verifyResetCode, confirmReset, notifyPasswordChanged } = useAuth();

  // Firebase action links carry ?mode=resetPassword&oobCode=...  We accept the
  // link regardless of `mode` as long as an oobCode is present and verifies.
  const oobCode = params.get("oobCode") || "";

  const [phase, setPhase] = useState<Phase>("verifying");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    if (!oobCode) { setPhase("invalid"); return; }
    verifyResetCode(oobCode).then((res) => {
      if (!active) return;
      if (res.success) { setEmail(res.email || ""); setPhase("ready"); }
      else setPhase("invalid");
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oobCode]);

  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH && password === confirm && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) { toast.error(t("resetPassword.errShort")); return; }
    if (password !== confirm) { toast.error(t("resetPassword.errMismatch")); return; }
    setLoading(true);
    const res = await confirmReset(oobCode, password);
    setLoading(false);
    if (res.success) {
      // Best-effort: tell the backend to audit + email a security alert.
      // The `email` came from Firebase's verifyPasswordResetCode, so it's
      // the account that was actually reset. Fire-and-forget.
      void notifyPasswordChanged(email);
      setPhase("done");
      toast.success(t("resetPassword.successToast"));
    } else if (res.error?.includes("expired-action-code")) {
      setPhase("invalid");
    } else {
      toast.error(t("resetPassword.errGeneric"));
    }
  };

  const inputClass =
    "w-full pl-10 pr-11 py-3 bg-background border border-border rounded-xl text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8">
        <Link to="/login" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-4 h-4" /> {t("resetPassword.back")}
        </Link>

        {phase === "verifying" && (
          <div className="text-center py-8">
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <p className="text-muted-foreground">{t("resetPassword.verifying")}</p>
          </div>
        )}

        {phase === "invalid" && (
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-destructive" />
            </div>
            <h2 className="font-display text-2xl font-bold mb-2">{t("resetPassword.invalidTitle")}</h2>
            <p className="text-muted-foreground mb-6">{t("resetPassword.invalidSubtitle")}</p>
            <Button className="rounded-xl" asChild>
              <Link to="/forgot-password">{t("resetPassword.requestNew")}</Link>
            </Button>
          </div>
        )}

        {phase === "ready" && (
          <>
            <div>
              <h1 className="font-display text-3xl font-extrabold text-foreground">{t("resetPassword.title")}</h1>
              <p className="text-muted-foreground mt-2">
                {email
                  ? t("resetPassword.subtitleFor", { email })
                  : t("resetPassword.subtitle")}
              </p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="text-sm font-medium block mb-2">{t("resetPassword.newLabel")}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder={t("resetPassword.newPlaceholder")} autoComplete="new-password" className={inputClass} />
                  <button type="button" onClick={() => setShowPw(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium block mb-2">{t("resetPassword.confirmLabel")}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input type={showPw ? "text" : "password"} value={confirm} onChange={e => setConfirm(e.target.value)}
                    placeholder={t("resetPassword.confirmPlaceholder")} autoComplete="new-password" className={inputClass} />
                </div>
                {confirm.length > 0 && password !== confirm && (
                  <p className="text-xs text-destructive mt-1.5">{t("resetPassword.errMismatch")}</p>
                )}
              </div>
              <Button type="submit" className="w-full h-12 rounded-xl text-base font-semibold" disabled={!canSubmit}>
                {loading ? t("resetPassword.saving") : t("resetPassword.save")}
              </Button>
            </form>
          </>
        )}

        {phase === "done" && (
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>
            <h2 className="font-display text-2xl font-bold mb-2">{t("resetPassword.doneTitle")}</h2>
            <p className="text-muted-foreground mb-6">{t("resetPassword.doneSubtitle")}</p>
            <Button className="rounded-xl" onClick={() => navigate("/login")}>{t("resetPassword.toLogin")}</Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
