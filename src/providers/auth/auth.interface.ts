/**
 * Auth Provider Interface
 * 
 * MIGRATION: Implement this interface for your target auth provider.
 * - AWS Cognito: CognitoAuthProvider
 * - Clerk: ClerkAuthProvider
 * - Custom JWT: CustomAuthProvider
 */

import type { AuthUser, AuthSession, ServiceResult } from '@/types/domain';

export interface ConfirmationResult {
  verificationId: string;
}

export interface IAuthProvider {
  /** Sign up with email and password */
  signUp(email: string, password: string, metadata?: Record<string, any>): Promise<ServiceResult<AuthSession>>;
  
  /** Sign in with email and password */
  signIn(email: string, password: string): Promise<ServiceResult<AuthSession>>;

  /** Start phone OTP auth */
  signInWithPhone(phoneNumber: string, recaptchaContainerId: string): Promise<ServiceResult<ConfirmationResult>>;

  /** Verify phone OTP */
  verifyOtp(verificationId: string, otp: string): Promise<ServiceResult<AuthSession>>;
  
  /** Sign in with OAuth provider */
  signInWithOAuth(provider: 'google' | 'apple' | 'github'): Promise<ServiceResult<void>>;
  
  /** Sign out current user */
  signOut(): Promise<ServiceResult<void>>;
  
  /** Get current session */
  getSession(): Promise<AuthSession | null>;
  
  /** Get current user */
  getCurrentUser(): Promise<AuthUser | null>;
  
  /** Send password reset email */
  resetPassword(email: string): Promise<ServiceResult<void>>;

  /** Validate a password-reset oobCode (from the emailed link) and return the
   *  account email it belongs to. Used by the reset-completion page. */
  verifyPasswordResetCode(oobCode: string): Promise<ServiceResult<{ email: string }>>;

  /** Complete a password reset: set a new password for the oobCode's account. */
  confirmPasswordReset(oobCode: string, newPassword: string): Promise<ServiceResult<void>>;

  /** Update password */
  updatePassword(newPassword: string): Promise<ServiceResult<void>>;
  
  /** Listen to auth state changes */
  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): () => void;
}
