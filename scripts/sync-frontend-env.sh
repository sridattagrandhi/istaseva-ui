#!/usr/bin/env bash
# Pull the frontend env file for a given environment from AWS Secrets Manager
# and write it to .env.<environment>. The secret name is the source of truth;
# the local file is treated as a regenerable cache.
#
# Usage: ./scripts/sync-frontend-env.sh staging
#        ./scripts/sync-frontend-env.sh production
#
# Requires: AWS_PROFILE (default: instaserve), AWS_REGION (default: ap-south-1).
set -euo pipefail

ENV_NAME="${1:-staging}"
case "$ENV_NAME" in
  staging|production) ;;
  *) echo "error: env must be 'staging' or 'production', got '$ENV_NAME'" >&2; exit 1 ;;
esac

PROFILE="${AWS_PROFILE:-instaserve}"
REGION="${AWS_REGION:-ap-south-1}"
SECRET_ID="instaserve/${ENV_NAME}/frontend-env"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="${ROOT}/.env.${ENV_NAME}"

echo "→ Fetching ${SECRET_ID} from Secrets Manager (${REGION})..."
JSON="$(AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
  aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query 'SecretString' --output text)"

# Convert {"KEY":"value", ...} to KEY=value lines, sorted for stable diffs.
echo "$JSON" | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
for k in sorted(data):
    print(f"{k}={data[k]}")
' > "$OUT_FILE"

echo "✓ Wrote $(wc -l < "$OUT_FILE" | tr -d " ") vars to ${OUT_FILE}"
