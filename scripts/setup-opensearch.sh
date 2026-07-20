#!/bin/bash
# ═══════════════════════════════════════════
# OpenSearch index setup is now handled in-process at boot by
#   server/src/modules/listings/services/listings-index.service.ts::ensureListingsIndex
#
# The API server auto-creates the `listings` index with the correct mapping
# on first boot and kicks off a Postgres→OpenSearch backfill in the
# background. Dual-write from listings.service keeps it in sync afterwards.
#
# This script is kept only as a reference for the mapping shape. Do not run
# it by hand — it will fight with the app, and its mapping is guaranteed to
# drift from what ensureListingsIndex() emits.
#
# To re-index from scratch (e.g. after a mapping change):
#   1. DELETE the listings index via OpenSearch dashboards or curl
#   2. Restart the API service — ensureListingsIndex() recreates + backfills
# ═══════════════════════════════════════════
echo "This script is deprecated. See server/src/modules/listings/services/listings-index.service.ts"
exit 0
