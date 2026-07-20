// Grant (or revoke) the `admin` role on a user via Firebase custom claims.
// The admin analytics portal (web `/admin`) and the `/api/admin/*` routes both
// gate on this claim (req.user.role === 'admin').
//
// Usage (from server/):
//   node scripts/grant-admin.js user@example.com
//   node scripts/grant-admin.js --uid <firebase-uid>
//   node scripts/grant-admin.js user@example.com --revoke
//
// Credentials come from the same env the server uses:
//   FIREBASE_PROJECT_ID + one of
//   FIREBASE_SERVICE_ACCOUNT_JSON | FIREBASE_SERVICE_ACCOUNT_PATH | ADC.
import fs from 'node:fs';
import dotenv from 'dotenv';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

dotenv.config();

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const uidFlagIdx = args.indexOf('--uid');
const uid = uidFlagIdx >= 0 ? args[uidFlagIdx + 1] : null;
const email = args.find((a) => !a.startsWith('--') && a !== uid);

if (!uid && !email) {
  console.error('Usage: node scripts/grant-admin.js <email> | --uid <uid> [--revoke]');
  process.exit(1);
}

function credential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return cert(JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')));
  }
  return applicationDefault();
}

async function main() {
  initializeApp({ credential: credential(), projectId: process.env.FIREBASE_PROJECT_ID });
  const auth = getAuth();

  const user = uid ? await auth.getUser(uid) : await auth.getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (revoke) {
    delete claims.role;
  } else {
    claims.role = 'admin';
  }
  await auth.setCustomUserClaims(user.uid, claims);

  console.log(`${revoke ? 'Revoked admin from' : 'Granted admin to'} ${user.email || user.uid} (uid: ${user.uid}).`);
  console.log('The user must sign out and back in (or refresh their ID token) for the new claim to take effect.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
