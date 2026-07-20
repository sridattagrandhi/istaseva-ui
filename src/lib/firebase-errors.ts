// Friendly messages for the Firebase phone-auth error strings we surface.
// The raw error.message from Firebase is something like
// "Firebase: Error (auth/invalid-verification-code)." — useless to a user.
// This helper extracts the `auth/...` code and maps it to a sentence that
// tells the user what's wrong and what to do.
//
// The same helper is used by both the login OTP screen and the post-signup
// /verify OTP screen so the wording stays consistent.

// Email/password sign-in variant of the mapper below. Firebase deliberately
// collapses wrong-password and unknown-email into `auth/invalid-credential`
// (anti-enumeration), so the headline message covers both. Returns null for
// unrecognized codes so callers can fall back to their own generic copy.
export function friendlyLoginError(rawMessage: string | undefined): string | null {
  if (!rawMessage) return null;
  const match = rawMessage.match(/auth\/[a-z-]+/i);
  const code = match ? match[0] : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password. Please try again.";
    case "auth/invalid-email":
      return "That email address doesn't look right. Check it and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact support if you think this is a mistake.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes before trying again.";
    case "auth/network-request-failed":
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    default:
      return null;
  }
}

export function friendlyOtpError(rawMessage: string | undefined): string | null {
  if (!rawMessage) return null;
  const match = rawMessage.match(/auth\/[a-z-]+/i);
  const code = match ? match[0] : "";
  switch (code) {
    case "auth/invalid-verification-code":
      return "That code didn't match. Double-check the SMS and try again.";
    case "auth/code-expired":
      return "That code has expired. Tap Resend to get a fresh one.";
    case "auth/missing-verification-code":
      return "Enter the 6-digit code from the SMS.";
    case "auth/credential-already-in-use":
    case "auth/account-exists-with-different-credential":
      return "This phone number is already linked to another account. Sign in with that account, or use a different number.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes before trying again.";
    case "auth/quota-exceeded":
      return "We've hit today's SMS quota. Please try again later.";
    case "auth/provider-already-linked":
      return "A phone number is already linked to this account.";
    case "auth/invalid-phone-number":
      return "That phone number doesn't look right. Check the country code and digits.";
    case "auth/session-expired":
      return "Your verification window expired. Tap Resend to get a new code.";
    default:
      return null;
  }
}
