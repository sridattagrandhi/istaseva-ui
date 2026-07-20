#!/usr/bin/env node
/**
 * Pre-build sanity check: fail loudly if `.env.<mode>` is missing or doesn't
 * contain the must-have keys. Catches the silent-build-with-localhost-URLs
 * footgun we hit on staging.
 *
 * Usage: node scripts/check-frontend-env.js staging
 */
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2];
if (!mode) {
  console.error('check-frontend-env: missing mode argument (staging|production)');
  process.exit(2);
}

const file = path.join(__dirname, '..', `.env.${mode}`);
if (!fs.existsSync(file)) {
  console.error(`\n❌  ${file} is missing.\n   Run:  ./scripts/sync-frontend-env.sh ${mode}\n   then re-run the build.\n`);
  process.exit(1);
}

const content = fs.readFileSync(file, 'utf8');
const found = new Map();
for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  found.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
}

// The must-haves. If a build is missing any of these, it's broken at runtime.
const required = [
  'VITE_API_URL',
  'VITE_WS_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_AUTH_PROVIDER',
];

const missing = required.filter((k) => !found.get(k));
if (missing.length) {
  console.error(`\n❌  ${path.basename(file)} is missing required keys: ${missing.join(', ')}`);
  console.error(`   Run:  ./scripts/sync-frontend-env.sh ${mode}\n`);
  process.exit(1);
}

// API URL must not point at localhost for non-dev builds, otherwise the
// deployed bundle ships with broken backend calls.
if (mode !== 'development') {
  const api = found.get('VITE_API_URL') || '';
  if (/localhost|127\.0\.0\.1/.test(api)) {
    console.error(`\n❌  VITE_API_URL=${api} points at localhost in ${mode} build.`);
    console.error(`   That will ship a broken bundle. Fix .env.${mode} and rebuild.\n`);
    process.exit(1);
  }
}

console.log(`✓  .env.${mode} ok (${found.size} vars, ${required.length} required keys present)`);
