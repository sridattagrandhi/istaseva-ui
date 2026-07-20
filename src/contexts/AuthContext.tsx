import React, { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAuthProvider } from "@/config/providers";
import { env } from "@/config/environment";
import { getAuth, reload, sendEmailVerification } from "firebase/auth";
import type { AuthSession, AuthUser, VerificationStatus } from "@/types/domain";
import { getUserService } from "@/domains/users/user.service";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

export type UserRole = string;

export interface User extends AuthUser {
  name: string;
  phone: string;
  role: UserRole;
  avatar: string;
  language: string;
  location: string;
  memberSince: string;
  verificationStatus?: VerificationStatus;
  verifiedAt?: string;
}

interface AuthContextType {
  user: User | null;
  session: AuthSession | null;
  loading: boolean;
  isAuthenticated: boolean;
  verificationStep: "email" | "phone" | "complete";
  login: (email: string, password: string) => Promise<{ user: User | null; error?: string }>;
  signup: (name: string, email: string, password: string, role: UserRole) => Promise<boolean>;
  signInWithPhone: (phoneNumber: string, recaptchaContainerId: string) => Promise<{ success: boolean; verificationId?: string; error?: string }>;
  verifyOtp: (verificationId: string, otp: string) => Promise<{ success: boolean; error?: string }>;
  resendEmailVerification: () => Promise<boolean>;
  refreshSession: () => Promise<boolean>;
  refreshVerification: () => Promise<void>;
  logout: () => void;
  resetPassword: (email: string) => Promise<boolean>;
  verifyResetCode: (oobCode: string) => Promise<{ success: boolean; email?: string; error?: string }>;
  confirmReset: (oobCode: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  notifyPasswordChanged: (email: string) => Promise<void>;
  logoutAllDevices: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function initialsFromName(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2) || "IS";
}

function mapAuthUser(authUser: AuthUser | null): User | null {
  if (!authUser) return null;

  const metadata = authUser.metadata || {};
  const displayName =
    (typeof metadata.displayName === "string" && metadata.displayName) ||
    (typeof metadata.name === "string" && metadata.name) ||
    authUser.email?.split("@")[0] ||
    authUser.phone ||
    "User";
  const role = typeof metadata.role === "string" ? metadata.role : "guest";
  const createdAt = authUser.createdAt ? new Date(authUser.createdAt) : new Date();

  return {
    ...authUser,
    name: displayName,
    phone: authUser.phone || "",
    role,
    avatar: typeof metadata.avatar === "string" && metadata.avatar ? metadata.avatar : initialsFromName(displayName),
    language: typeof metadata.language === "string" ? metadata.language : "English",
    location: typeof metadata.location === "string" ? metadata.location : "India",
    memberSince: createdAt.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const authProvider = useMemo(() => getAuthProvider(), []);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { enableIfAlreadyGranted: refreshPushToken } = usePushNotifications();
  const pushEnabled = useRef(false);

  const verificationStep = useMemo<"email" | "phone" | "complete">(() => {
    if (!user) return "email";
    if (!user.emailVerified) return "email";
    if (!user.phoneVerified) return "phone";
    return "complete";
  }, [user]);

  // Hydrates the user's per-user KYC status onto the User object. Runs
  // best-effort after auth — failures (e.g. user_profiles row missing) leave
  // verificationStatus undefined and the UI falls back to "pending".
  //
  // Retries with backoff: this fires at auth boot, the one moment the local
  // backend may still be starting or port discovery can transiently fail. A
  // single swallowed failure used to leave a verified provider seeing the
  // "Complete your KYC" banner for the whole session.
  const hydrateVerification = async (authUserId: string) => {
    for (const delayMs of [0, 2000, 8000]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const result = await getUserService().getProfile(authUserId);
        if (!result.success || !result.data) continue;
        const { verificationStatus, verifiedAt } = result.data;
        // Guard on id so a late retry can't stamp a previous account's
        // status after sign-out / account switch.
        setUser((prev) => (prev && prev.id === authUserId ? { ...prev, verificationStatus, verifiedAt } : prev));
        return;
      } catch {
        // Swallow and retry — verification status is non-critical for app boot.
      }
    }
  };

  // Auth-state events replace the whole user object with a fresh mapping
  // that has no verificationStatus. Carry the hydrated KYC fields over when
  // it's the same account, so a token refresh doesn't resurrect the banner
  // while re-hydration is in flight.
  const setUserPreservingVerification = (mapped: User | null) => {
    setUser((prev) =>
      prev && mapped && prev.id === mapped.id
        ? { ...mapped, verificationStatus: prev.verificationStatus, verifiedAt: prev.verifiedAt }
        : mapped,
    );
  };

  useEffect(() => {
    let mounted = true;

    authProvider.getSession().then((currentSession) => {
      if (!mounted) return;
      setSession(currentSession);
      const mapped = mapAuthUser(currentSession?.user || null);
      setUserPreservingVerification(mapped);
      setLoading(false);
      if (mapped?.id) void hydrateVerification(mapped.id);
    }).catch(() => {
      if (!mounted) return;
      setSession(null);
      setUser(null);
      setLoading(false);
    });

    const unsubscribe = authProvider.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      const mapped = mapAuthUser(nextSession?.user || null);
      setUserPreservingVerification(mapped);
      setLoading(false);
      if (mapped?.id) void hydrateVerification(mapped.id);
      // Refresh the FCM token on sign-in IF the user previously granted
      // browser-notification permission. We deliberately do NOT prompt
      // here — that would fire the browser dialog on every cold load,
      // which most users dismiss. The NotificationsDropdown surfaces an
      // explicit "Enable notifications" CTA for first-time enablement.
      if (nextSession?.user && !pushEnabled.current) {
        pushEnabled.current = true;
        void refreshPushToken();
      }
      if (!nextSession?.user) {
        pushEnabled.current = false;
      }
      // LEG-001: if a signup-time terms-consent write was dropped, re-fire
      // it now that we have an authenticated session (no-op otherwise).
      // LEG-014: also reconcile the device cookie/analytics choice into the
      // server consent register (e.g. chosen in the banner before signing in).
      if (nextSession?.user) {
        void import("@/domains/legal/legal.service").then(({ getLegalService }) => {
          const legal = getLegalService();
          void legal.retryPendingTermsConsent();
          void legal.syncAnalyticsConsent();
        }).catch(() => undefined);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [authProvider]);

  const login = async (email: string, password: string) => {
    const result = await authProvider.signIn(email, password);
    // Surface the provider's raw error (e.g. "Firebase: Error
    // (auth/invalid-credential).") so the login page can map it to a
    // friendly message — returning bare null left the form silent on a
    // wrong password.
    if (!result.success || !result.data) return { user: null, error: result.error };
    const mapped = mapAuthUser(result.data.user);
    setSession(result.data);
    setUser(mapped);
    getAnalyticsEventsService().track("login", { source: "email" });
    return { user: mapped };
  };

  const signup = async (name: string, email: string, password: string, role: UserRole) => {
    const result = await authProvider.signUp(email, password, { name, role });
    if (!result.success || !result.data) return false;
    if (env.auth.provider === "firebase" && getAuth().currentUser) {
      // Pass ActionCodeSettings with our app origin so Firebase wraps the
      // verification URL in the email body as a clickable link AND so the
      // returnTo target after verification is our /verify page (where we
      // poll for `emailVerified` and continue the flow). Without this
      // setting Gmail and Outlook sometimes render the bare action URL as
      // plain text that the user has to copy/paste — exactly the bug the
      // user reported.
      await sendEmailVerification(getAuth().currentUser, {
        url: `${window.location.origin}/verify`,
        handleCodeInApp: false,
      });
    }
    setSession(result.data);
    setUser(mapAuthUser({
      ...result.data.user,
      metadata: {
        ...(result.data.user.metadata || {}),
        name,
        role,
      },
    }));
    getAnalyticsEventsService().track("signup", { source: "email", props: { role } });
    return true;
  };

  const signInWithPhone = async (phoneNumber: string, recaptchaContainerId: string) => {
    const result = await authProvider.signInWithPhone(phoneNumber, recaptchaContainerId);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      verificationId: result.data.verificationId,
    };
  };

  const verifyOtp = async (verificationId: string, otp: string) => {
    const result = await authProvider.verifyOtp(verificationId, otp);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }
    setSession(result.data);
    setUser(mapAuthUser(result.data.user));
    getAnalyticsEventsService().track("login", { source: "phone" });
    return { success: true };
  };

  const resendEmailVerification = async () => {
    try {
      if (env.auth.provider !== "firebase" || !getAuth().currentUser) return false;
      // Match the original signup-time call so the resent link comes back to
      // /verify and renders as a real <a> in the mail body (Firebase only
      // wraps the URL when ActionCodeSettings.url is set).
      await sendEmailVerification(getAuth().currentUser, {
        url: `${window.location.origin}/verify`,
        handleCodeInApp: false,
      });
      return true;
    } catch {
      return false;
    }
  };

  // Public version of the verification hydrator. Pages call this after an
  // action (e.g. uploading a KYC doc) that may have flipped
  // user_profiles.verification_status on the backend, so the AuthContext —
  // and any consumer reading user.verificationStatus — re-renders without
  // requiring a page reload.
  const refreshVerification = async () => {
    if (!user?.id) return;
    await hydrateVerification(user.id);
  };

  const refreshSession = async () => {
    try {
      if (env.auth.provider === "firebase" && getAuth().currentUser) {
        await reload(getAuth().currentUser);
      }
      const nextSession = await authProvider.getSession();
      setSession(nextSession);
      setUser(mapAuthUser(nextSession?.user || null));
      return Boolean(nextSession);
    } catch {
      return false;
    }
  };

  const logout = () => {
    void authProvider.signOut().finally(() => {
      setSession(null);
      setUser(null);
    });
  };

  // "Sign out everywhere": ask the backend to revoke every session (kills the
  // still-unexpired tokens on other devices), THEN clear this device locally.
  // Returns false if the revoke call failed — the caller can warn that other
  // devices may still be signed in. Local sign-out always runs regardless.
  const logoutAllDevices = async () => {
    let revoked = false;
    try {
      const result = await apiRequest<{ success: boolean }>("/api/auth/logout-all", {
        method: "POST",
        headers: getJsonHeaders(),
      });
      revoked = !!(result.success && result.data?.success);
    } catch {
      revoked = false;
    }
    await authProvider.signOut().catch(() => {});
    setSession(null);
    setUser(null);
    return revoked;
  };

  // Route the reset request through our own backend (branded email via SES,
  // rate limiting, enumeration-safe response). If the backend's email pipeline
  // isn't configured (delivered=false — e.g. no SES creds in dev) or the
  // request fails, fall back to Firebase's built-in sender so a reset link
  // always reaches the user.
  const resetPassword = async (email: string) => {
    const result = await apiRequest<{ success: boolean; delivered?: boolean }>("/api/auth/forgot-password", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({ email }),
    });
    if (result.success && result.data?.delivered) return true;
    const fallback = await authProvider.resetPassword(email);
    return fallback.success;
  };

  const verifyResetCode = async (oobCode: string) => {
    const result = await authProvider.verifyPasswordResetCode(oobCode);
    return { success: result.success, email: result.data?.email, error: result.error };
  };

  const confirmReset = async (oobCode: string, newPassword: string) => {
    const result = await authProvider.confirmPasswordReset(oobCode, newPassword);
    return { success: result.success, error: result.error };
  };

  // Best-effort security signal, fired after a successful reset. The backend
  // audits the change and emails a "your password was changed" alert. Never
  // throws — a notification hiccup must not break the completed reset UX.
  const notifyPasswordChanged = async (email: string) => {
    if (!email) return;
    try {
      await apiRequest("/api/auth/password-changed", {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({ email }),
      });
    } catch {
      /* swallow — the reset already succeeded */
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        isAuthenticated: !!user,
        verificationStep,
        login,
        signup,
        signInWithPhone,
        verifyOtp,
        resendEmailVerification,
        refreshSession,
        refreshVerification,
        logout,
        logoutAllDevices,
        resetPassword,
        verifyResetCode,
        confirmReset,
        notifyPasswordChanged,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
