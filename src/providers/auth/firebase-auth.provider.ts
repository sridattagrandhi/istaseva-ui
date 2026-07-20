import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  PhoneAuthProvider,
  RecaptchaVerifier,
  createUserWithEmailAndPassword,
  linkWithCredential,
  linkWithPhoneNumber,
  confirmPasswordReset as fbConfirmPasswordReset,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  verifyPasswordResetCode as fbVerifyPasswordResetCode,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updatePassword as updateFirebasePassword,
  updateProfile,
  type User as FirebaseUser,
} from "firebase/auth";
import { frontendConfig } from "@/config/frontend";
import type { AuthSession, AuthUser, ServiceResult } from "@/types/domain";
import type { ConfirmationResult, IAuthProvider } from "./auth.interface";

export class FirebaseAuthProvider implements IAuthProvider {
  private app: FirebaseApp;
  private auth = getAuth(this.ensureApp());
  private recaptchaVerifiers = new Map<string, RecaptchaVerifier>();

  constructor() {
    this.app = this.ensureApp();
  }

  private ensureApp(): FirebaseApp {
    if (getApps().length > 0) {
      return getApps()[0]!;
    }

    // Include appId / messagingSenderId / storageBucket when present —
    // Auth works without them, but FCM (initialized elsewhere via the same
    // default app) requires them or Firebase Installations throws.
    const cfg: Record<string, string> = {
      apiKey: frontendConfig.firebase.apiKey!,
      authDomain: frontendConfig.firebase.authDomain!,
      projectId: frontendConfig.firebase.projectId!,
    };
    if (frontendConfig.firebase.appId) cfg.appId = frontendConfig.firebase.appId;
    if (frontendConfig.firebase.messagingSenderId) cfg.messagingSenderId = frontendConfig.firebase.messagingSenderId;
    if (frontendConfig.firebase.storageBucket) cfg.storageBucket = frontendConfig.firebase.storageBucket;
    return initializeApp(cfg);
  }

  private async mapUser(user: FirebaseUser): Promise<AuthUser> {
    const tokenResult = await user.getIdTokenResult();
    return {
      id: user.uid,
      email: user.email || "",
      emailVerified: user.emailVerified,
      phone: user.phoneNumber || undefined,
      phoneVerified: !!user.phoneNumber,
      metadata: {
        displayName: user.displayName || undefined,
        avatarUrl: user.photoURL || undefined,
        role: typeof tokenResult.claims.role === "string" ? tokenResult.claims.role : undefined,
        claims: tokenResult.claims,
      },
      createdAt: user.metadata.creationTime || new Date().toISOString(),
    };
  }

  private async mapSession(user: FirebaseUser): Promise<AuthSession> {
    const token = await user.getIdToken();
    const tokenResult = await user.getIdTokenResult();
    const expiresAt = tokenResult.expirationTime
      ? new Date(tokenResult.expirationTime).getTime()
      : Date.now() + 60 * 60 * 1000;

    return {
      accessToken: token,
      refreshToken: "",
      expiresAt,
      user: await this.mapUser(user),
    };
  }

  private getRecaptchaVerifier(containerId: string) {
    // Always clear any prior verifier for this container — reusing a verifier
    // whose DOM node was unmounted (e.g. after navigating away and back, or
    // after sign-out) throws "reCAPTCHA client element has been removed".
    this.clearRecaptchaVerifier(containerId);

    const verifier = new RecaptchaVerifier(this.auth, containerId, {
      size: "invisible",
    });
    this.recaptchaVerifiers.set(containerId, verifier);
    return verifier;
  }

  private clearRecaptchaVerifier(containerId: string) {
    const existing = this.recaptchaVerifiers.get(containerId);
    if (existing) {
      try { existing.clear(); } catch { /* node may already be gone */ }
      this.recaptchaVerifiers.delete(containerId);
    }
    // Belt-and-braces: even when we never tracked a verifier in our Map (e.g.
    // a previous hard navigation or React strict-mode double-invocation left
    // a widget rendered in this container), Firebase will refuse to mount a
    // new one with "reCAPTCHA has already been rendered in this element".
    // Strip any leftover iframe/script the SDK injected so the next
    // `new RecaptchaVerifier(...)` call starts from a clean slate.
    if (typeof document !== "undefined") {
      const el = document.getElementById(containerId);
      if (el) el.innerHTML = "";
    }
  }

  private clearAllRecaptchaVerifiers() {
    for (const id of Array.from(this.recaptchaVerifiers.keys())) {
      this.clearRecaptchaVerifier(id);
    }
  }

  async signUp(email: string, password: string, metadata?: Record<string, any>): Promise<ServiceResult<AuthSession>> {
    try {
      const credential = await createUserWithEmailAndPassword(this.auth, email, password);
      if (metadata?.name) {
        await updateProfile(credential.user, { displayName: metadata.name });
      }
      return { success: true, data: await this.mapSession(credential.user) };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async signIn(email: string, password: string): Promise<ServiceResult<AuthSession>> {
    try {
      const credential = await signInWithEmailAndPassword(this.auth, email, password);
      // Force a token refresh so freshly-granted custom claims (e.g. an `admin`
      // role set via the Admin SDK) are present in this session immediately,
      // rather than only after Firebase's next background refresh. Without this
      // a just-promoted admin lands on the token minted a beat before the claim
      // propagated, so `user.role` reads "guest" until a full reload.
      await credential.user.getIdToken(true);
      return { success: true, data: await this.mapSession(credential.user) };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async signInWithPhone(phoneNumber: string, recaptchaContainerId: string): Promise<ServiceResult<ConfirmationResult>> {
    try {
      const verifier = this.getRecaptchaVerifier(recaptchaContainerId);
      const confirmation = this.auth.currentUser
        ? await linkWithPhoneNumber(this.auth.currentUser, phoneNumber, verifier)
        : await signInWithPhoneNumber(this.auth, phoneNumber, verifier);
      return {
        success: true,
        data: {
          verificationId: confirmation.verificationId,
        },
      };
    } catch (error: any) {
      // Whether send succeeded or failed, the verifier is single-use — drop it
      // so the next attempt doesn't try to render into a stale widget.
      this.clearRecaptchaVerifier(recaptchaContainerId);
      return { success: false, error: error.message };
    }
  }

  async verifyOtp(verificationId: string, otp: string): Promise<ServiceResult<AuthSession>> {
    try {
      const credential = PhoneAuthProvider.credential(verificationId, otp);
      const result = this.auth.currentUser && !this.auth.currentUser.phoneNumber
        ? await linkWithCredential(this.auth.currentUser, credential)
        : await signInWithCredential(this.auth, credential);
      // Force-refresh so custom claims are present immediately (see signIn).
      await result.user.getIdToken(true);
      return { success: true, data: await this.mapSession(result.user) };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async signInWithOAuth(provider: "google" | "apple" | "github"): Promise<ServiceResult<void>> {
    try {
      if (provider !== "google") {
        return { success: false, error: `${provider} OAuth is not configured for this provider` };
      }

      const googleProvider = new GoogleAuthProvider();
      await signInWithPopup(this.auth, googleProvider);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async signOut(): Promise<ServiceResult<void>> {
    try {
      await signOut(this.auth);
      this.clearAllRecaptchaVerifiers();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getSession(): Promise<AuthSession | null> {
    // authStateReady() resolves once Firebase has restored the persisted session
    // from IndexedDB. Without this, currentUser is null during the first render
    // and every API call goes out with no Authorization header (→ 401).
    await this.auth.authStateReady();
    if (!this.auth.currentUser) return null;
    return this.mapSession(this.auth.currentUser);
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    if (!this.auth.currentUser) return null;
    return this.mapUser(this.auth.currentUser);
  }

  async resetPassword(email: string): Promise<ServiceResult<void>> {
    try {
      await sendPasswordResetEmail(this.auth, email);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async verifyPasswordResetCode(oobCode: string): Promise<ServiceResult<{ email: string }>> {
    try {
      const email = await fbVerifyPasswordResetCode(this.auth, oobCode);
      return { success: true, data: { email } };
    } catch (error: any) {
      return { success: false, error: error.code || error.message };
    }
  }

  async confirmPasswordReset(oobCode: string, newPassword: string): Promise<ServiceResult<void>> {
    try {
      await fbConfirmPasswordReset(this.auth, oobCode, newPassword);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.code || error.message };
    }
  }

  async updatePassword(newPassword: string): Promise<ServiceResult<void>> {
    try {
      if (!this.auth.currentUser) {
        return { success: false, error: "Not authenticated" };
      }
      await updateFirebasePassword(this.auth.currentUser, newPassword);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): () => void {
    return onAuthStateChanged(this.auth, async (user) => {
      if (!user) {
        callback("SIGNED_OUT", null);
        return;
      }

      callback("SIGNED_IN", await this.mapSession(user));
    });
  }
}
