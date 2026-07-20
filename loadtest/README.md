# Load tests

[k6](https://k6.io) scripts for stress-testing the staging/production API.

These exercise the realistic hot paths (auth → search → listing detail →
chat) rather than synthetic endpoints, so results reflect what happens
under real user load.

## Install

```sh
brew install k6   # macOS
# or download from https://k6.io/docs/get-started/installation/
```

## Run

Against staging:

```sh
# Baseline smoke test (30 s, 10 VUs)
BASE_URL=https://staging.istaseva.com \
ID_TOKEN="$(firebase auth:print-access-token)" \
  k6 run loadtest/scenarios/smoke.js

# 10k-user target (ramps to 2k concurrent, 5 min)
BASE_URL=https://staging.istaseva.com \
ID_TOKEN="..." \
  k6 run loadtest/scenarios/sustained-2k.js
```

`ID_TOKEN` is a Firebase ID token for a test user. Any request that hits
an authenticated route uses it as `Authorization: Bearer <token>`.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | API base, no trailing slash |
| `ID_TOKEN` | _empty_ | Firebase ID token for authenticated calls |
| `RECEIVER_ID` | `e2e-test-receiver-uid` | UID to send chat messages to |

## Thresholds

Every scenario defines SLO-style thresholds (p95 latency, error rate). If
a run breaches them, k6 exits non-zero — so you can wire this into CI.

## Interpreting results

Look at:
- `http_req_duration{p(95)}` — should stay under 500 ms for reads, 1 s for writes
- `http_req_failed` — should be < 1 %
- `checks` — custom assertions pass-rate should be 100 %

Any sustained breach usually points at one of the Phase 1 bottlenecks we
already hardened (DB connections → RDS Proxy, chat list → conversations
table, WS fan-out → Redis pub/sub). First, confirm those are deployed.
