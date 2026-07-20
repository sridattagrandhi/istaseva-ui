#!/usr/bin/env bash
# Upload the built frontend (dist/) to S3 + invalidate CloudFront with CORRECT
# cache headers. This REPLACES the raw `aws s3 sync dist/ ... --delete` step —
# same bucket, same --delete pruning, same invalidation — it only adds the cache
# metadata that plain `s3 sync` omits.
#
# Why two passes: index.html is a POINTER to content-hashed assets. Files under
# assets/ are fingerprinted, so they cache forever (immutable). index.html and
# the service worker are NOT hashed and must NEVER be cached — otherwise a
# returning visitor's browser paints the previous build (pointing at old asset
# hashes) before it revalidates and fetches the new pointer. That is the "old
# version flashes first, then the current page loads" bug. Plain `s3 sync` sets
# no Cache-Control, so the browser heuristically caches index.html and you hit it.
#
# Build FIRST (this script does not build): npm run build:<env>  (see Step 6).
#
# Usage: ./scripts/deploy-frontend.sh staging
#        DISTRIBUTION_ID=EXXXXXXXX ./scripts/deploy-frontend.sh production
#
# Requires: AWS_REGION (default: ap-south-1) and AWS credentials. Locally those
# come from a named profile (AWS_PROFILE, default: instaserve). In CI (GitHub
# Actions OIDC) they arrive as AWS_ACCESS_KEY_ID / AWS_SESSION_TOKEN env vars and
# there is NO named profile — see the credential block below.
set -euo pipefail

ENV_NAME="${1:-staging}"
case "$ENV_NAME" in
  staging|production) ;;
  *) echo "error: env must be 'staging' or 'production', got '$ENV_NAME'" >&2; exit 1 ;;
esac

REGION="${AWS_REGION:-ap-south-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${ROOT}/dist"
BUCKET="s3://instaserve-frontend-${ENV_NAME}"

# Distribution id is known for staging; production must supply it explicitly
# (guessing an account's second distribution would invalidate the wrong one).
if [[ -n "${DISTRIBUTION_ID:-}" ]]; then
  DIST_ID="$DISTRIBUTION_ID"
elif [[ "$ENV_NAME" == "staging" ]]; then
  DIST_ID="E1FBU5O1WALCVT"
else
  echo "error: set DISTRIBUTION_ID for ${ENV_NAME} (only staging has a default)" >&2; exit 1
fi

[[ -f "${DIST_DIR}/index.html" ]] || {
  echo "error: ${DIST_DIR}/index.html missing — run the build first (npm run build:${ENV_NAME})" >&2
  exit 1
}

export AWS_REGION="$REGION"
# Credentials: locally, fall back to the 'instaserve' named profile. In CI (GitHub
# Actions OIDC) configure-aws-credentials exports AWS_ACCESS_KEY_ID /
# AWS_SESSION_TOKEN and there is NO 'instaserve' profile — forcing AWS_PROFILE
# there aborts the CLI with "config profile could not be found". So only default
# the profile when the environment isn't already carrying its own credentials.
if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_ACCESS_KEY_ID:-}" && -z "${AWS_SESSION_TOKEN:-}" ]]; then
  export AWS_PROFILE=instaserve
fi

# Pass 1 — content-hashed assets: cache forever, immutable. Upload these BEFORE
# the pointer files so the new index.html never references a not-yet-uploaded
# asset. --delete (scoped to assets/ by the filter) prunes old build hashes.
echo "→ [1/3] Uploading immutable assets to ${BUCKET}/assets/ ..."
aws s3 sync "${DIST_DIR}/" "${BUCKET}/" --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "*" --include "assets/*"

# Pass 2 — pointer files (index.html, firebase-messaging-sw.js, favicon, robots,
# ...): no-cache so the browser always revalidates and picks up a new build
# immediately. --delete (scoped to everything except assets/) prunes stale roots.
echo "→ [2/3] Uploading no-cache pointer files (html + service worker) ..."
aws s3 sync "${DIST_DIR}/" "${BUCKET}/" --delete \
  --cache-control "no-cache" \
  --exclude "assets/*"

# iOS Universal Links: the Apple App Site Association file has NO extension, so
# the `s3 sync` above tags it application/octet-stream — which older iOS rejects.
# Re-put it with the JSON content type + no-cache so the association verifies.
# (assetlinks.json keeps its correct type from its extension.)
AASA_FILE="${DIST_DIR}/.well-known/apple-app-site-association"
if [[ -f "$AASA_FILE" ]]; then
  echo "→ Fixing Content-Type on .well-known/apple-app-site-association ..."
  aws s3 cp "$AASA_FILE" "${BUCKET}/.well-known/apple-app-site-association" \
    --content-type "application/json" --cache-control "no-cache"
fi

# Invalidate the edge so CloudFront serves the new build right away.
echo "→ [3/3] Invalidating CloudFront ${DIST_ID} ..."
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/*" --query 'Invalidation.Id' --output text

echo "✓ Deployed dist/ to ${ENV_NAME} (${BUCKET})"
