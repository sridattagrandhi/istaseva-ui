import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
  useCallback,
} from "react";
import firebaseAuth, { FirebaseAuthTypes } from "@react-native-firebase/auth";
import { auth } from "@/lib/firebase";
import { api } from "@/lib/api";
import { track } from "@/design/api/analyticsEvents";

type FbUser = FirebaseAuthTypes.User;

type AuthUser = {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  avatarUrl?: string;
  /** From the Firebase custom claim — gates the mobile admin area. */
  role?: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** "Sign out everywhere": revoke all sessions server-side, then sign out
   *  locally. Resolves false if the server revoke failed. */
  signOutAll: () => Promise<boolean>;
  resetPassword: (email: string) => Promise<void>;
  verifyResetCode: (oobCode: string) => Promise<string>;
  confirmReset: (oobCode: string, newPassword: string) => Promise<void>;
  /** Best-effort signal fired after a successful reset so the backend can
   *  audit the change and email a security alert. Never rejects. */
  notifyPasswordChanged: (email: string) => Promise<void>;
  /** Re-send the Firebase email-verification link to the signed-in user.
   *  Returns false when there's no user to send to (or the send failed). */
  resendVerificationEmail: () => Promise<boolean>;
  /** Request an OTP SMS for `phoneE164` (e.g. "+919876543210"). Must be called
   *  before `verifyPhoneOtp`. Resolves once the code has been sent. */
  sendPhoneOtp: (phoneE164: string) => Promise<void>;
  /** Confirm the OTP the user typed. If an email/password user is signed in and
   *  has no phone yet, the number is LINKED to that same account (so the backend
   *  syncs it from the token's phone_number claim); otherwise this signs the
   *  user in by phone. */
  verifyPhoneOtp: (code: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function mapUser(u: FbUser): AuthUser {
  return {
    id: u.uid,
    email: u.email ?? "",
    name: u.displayName ?? undefined,
    phone: u.phoneNumber ?? undefined,
    emailVerified: u.emailVerified,
    phoneVerified: !!u.phoneNumber,
    avatarUrl: u.photoURL ?? undefined,
  };
}

// Drive Firebase's phone-verification listener and resolve a verificationId as
// soon as the SMS is sent (state "sent") or auto-retrieved (state "verified").
// We resolve on "sent" rather than awaiting the listener's terminal state so the
// UI can prompt for the code immediately — awaiting would block until the
// Android auto-verify window times out. The returned verificationId is combined
// with the user-typed code to build a PhoneAuthProvider credential.
function requestVerificationId(phoneE164: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    auth.verifyPhoneNumber(phoneE164).on(
      "state_changed",
      (snapshot: FirebaseAuthTypes.PhoneAuthSnapshot) => {
        if (settled) return;
        if (snapshot.state === "sent" || snapshot.state === "verified") {
          settled = true;
          resolve(snapshot.verificationId);
        } else if (snapshot.state === "error") {
          settled = true;
          reject(snapshot.error ?? { code: "auth/phone-verification-failed" });
        }
      },
      (error: FirebaseAuthTypes.PhoneAuthError) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  // Carries the verificationId between sendPhoneOtp and verifyPhoneOtp.
  const phoneVerificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      setUser(u ? mapUser(u) : null);
      setLoading(false);
      // Pull the `role` custom claim asynchronously and fold it in.
      if (u) {
        u.getIdTokenResult()
          .then((r) => {
            const role = typeof r.claims.role === "string" ? r.claims.role : undefined;
            if (role) setUser((prev) => (prev && prev.id === u.uid ? { ...prev, role } : prev));
          })
          .catch(() => {});
      }
    });
    return unsub;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await auth.signInWithEmailAndPassword(email, password);
    void track("login", { source: "email" });
  }, []);

  const signUp = useCallback(async (email: string, password: string, name?: string) => {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    if (name) await cred.user.updateProfile({ displayName: name });
    // The onboarding "Verify your email" step tells the user a link was sent
    // — actually send it (web does the same at signup). Best-effort: a send
    // failure must not fail account creation; the user can tap Resend.
    cred.user.sendEmailVerification().catch(() => {});
    setUser(mapUser(cred.user));
    void track("signup", { source: "email" });
  }, []);

  const signOut = useCallback(async () => {
    phoneVerificationIdRef.current = null;
    await auth.signOut();
  }, []);

  // "Sign out everywhere": ask the backend to revoke every session (kills the
  // still-unexpired tokens on other devices), THEN sign out locally. Returns
  // false if the revoke call failed — the caller can warn that other devices
  // may still be active. Local sign-out always runs.
  const signOutAll = useCallback(async () => {
    let revoked = false;
    try {
      const res = await api.post("/api/auth/logout-all");
      revoked = res.data?.success === true;
    } catch {
      revoked = false;
    }
    phoneVerificationIdRef.current = null;
    try { await auth.signOut(); } catch {}
    return revoked;
  }, []);

  // Route the reset request through our own backend (branded email via SES,
  // rate limiting, enumeration-safe response). If the backend's email pipeline
  // isn't configured (delivered=false — e.g. no SES creds in dev) or the
  // request fails, fall back to Firebase's built-in sender so a reset link
  // always reaches the user.
  const resetPassword = useCallback(async (email: string) => {
    try {
      const res = await api.post("/api/auth/forgot-password", { email });
      if (res.data?.delivered) return;
    } catch {
      // fall through to the Firebase fallback below
    }
    await auth.sendPasswordResetEmail(email);
  }, []);

  // Completion (after tapping the emailed deep link). The oobCode is validated +
  // consumed by Firebase.
  const verifyResetCode = useCallback(async (oobCode: string) => {
    return auth.verifyPasswordResetCode(oobCode);
  }, []);

  const confirmReset = useCallback(async (oobCode: string, newPassword: string) => {
    await auth.confirmPasswordReset(oobCode, newPassword);
  }, []);

  // Best-effort: after a successful reset, tell the backend to audit the change
  // and email a "your password was changed" alert. The user isn't signed in
  // here, so this hits the public endpoint with no bearer token. Never throws —
  // the reset already succeeded and must not be reported as failed.
  const notifyPasswordChanged = useCallback(async (email: string) => {
    if (!email) return;
    try {
      await api.post("/api/auth/password-changed", { email });
    } catch {
      /* swallow — the reset already succeeded */
    }
  }, []);

  const resendVerificationEmail = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return false;
    try {
      await current.sendEmailVerification();
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendPhoneOtp = useCallback(async (phoneE164: string) => {
    phoneVerificationIdRef.current = await requestVerificationId(phoneE164);
  }, []);

  const verifyPhoneOtp = useCallback(async (code: string) => {
    const verificationId = phoneVerificationIdRef.current;
    if (!verificationId) throw { code: "auth/missing-verification-id" };
    const credential = firebaseAuth.PhoneAuthProvider.credential(verificationId, code);
    const current = auth.currentUser;
    // Signup case: an email/password user is signed in with no phone yet → LINK
    // the number to the SAME account (backend syncs it from the phone_number
    // token claim). Login case: no such user → sign in by phone.
    const result =
      current && !current.phoneNumber
        ? await current.linkWithCredential(credential)
        : await auth.signInWithCredential(credential);
    // Force a token refresh so the phone_number claim (and any custom claims)
    // are present on the very next authenticated request — that request is what
    // makes the backend persist user_profiles.phone.
    await result.user.getIdToken(true);
    setUser(mapUser(result.user));
    phoneVerificationIdRef.current = null;
    void track(current ? "verify_phone" : "login", {
      source: "phone",
      props: { mode: current ? "link" : "signin" },
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      signIn,
      signUp,
      signOut,
      signOutAll,
      resetPassword,
      verifyResetCode,
      confirmReset,
      notifyPasswordChanged,
      resendVerificationEmail,
      sendPhoneOtp,
      verifyPhoneOtp,
    }),
    [
      user,
      loading,
      signIn,
      signUp,
      signOut,
      signOutAll,
      resetPassword,
      verifyResetCode,
      confirmReset,
      notifyPasswordChanged,
      resendVerificationEmail,
      sendPhoneOtp,
      verifyPhoneOtp,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
