# AI Assistant — Staging Certification Runbook (by hand)

A manual, repeatable pass to certify the **live-model** behaviour of the chat
assistant on staging. The unit/replay suites stub the model, so they verify the
*plumbing* (tool filtering, availability gate, action promotion, pricing math)
but **cannot** catch a prompt regression where live Gemini stops emitting the
right tool calls — see the docstring in
`server/src/modules/chat/agent/__tests__/replay/assistant-replay.test.ts`. This
runbook is that missing layer. Run it after any change to the agent prompt,
tools, model, or the pricing/booking paths it touches.

When a scenario fails, fix it **and** encode the incident as a new canned
scenario in the replay harness so it can never silently regress again.

---

## Automated subset (run this first)

Four of the read-only scenarios below (S1, S2, S6, S7) are automated by
`server/scripts/assistant-smoke.mjs`, which fires the prompts at a deployed
`/api/assistant` and asserts on the returned `toolCalls[]` / `action` / reply
language. Run it before the manual pass to catch the obvious regressions fast:

```bash
cd server
# Prove the assertion logic (no token, no network):
npm run smoke:assistant:selftest
# Live run against staging (needs a Firebase ID token from a signed-in session):
SMOKE_TOKEN='<id token>' SMOKE_BASE_URL='https://d2ypux27ikks41.cloudfront.net' \
  npm run smoke:assistant
```

The availability gate (S3), pricing parity (S4), prepare-booking (S5), and
escalation (S8) are **not** automated — they need booking state, real payment,
or human judgement — so the manual pass below is still required for full
certification.

## Preconditions

- **Env:** staging — web app `https://staging.istaseva.com` (API is the same
  CloudFront origin, `https://d2ypux27ikks41.cloudfront.net`).
- **Login:** a real staging test user (the assistant endpoint is auth-gated,
  `POST /api/assistant`, `requireAuth`). Use the web chat UI so you also certify
  card/action rendering, not just the JSON.
- **Optional live trace:** in a terminal, tail the API logs to watch tool calls,
  the promoted `action`, and per-message token/₹ cost:
  ```bash
  aws logs tail /instaserve/staging/api --follow --region ap-south-1 --profile instaserve \
    | grep -iE "tool|action|assistant|token|usage|error"
  ```

## Real staging data used below (verified 2026-07-14)

Substitute if staging data changes — re-list with
`curl -s "https://d2ypux27ikks41.cloudfront.net/api/listings?limit=60"`.

| Category | Name | City |
|---|---|---|
| homestay | Skyline Homestays | Hyderabad |
| homestay | Srivari Sannidhi | Tirupati |
| hotel | Trident Hotels | Hyderabad |
| hotel | Hyderabad Marriott Hotel & Convention Centre | Hyderabad |
| cleaning (service) | Super Cleanings | Hyderabad |
| salon (service) | Truefitt & Hill, Banjara Hills | Hyderabad |
| driver-cab (transport) | Sridatta / Sridatta Grandhi | Hyderabad |

> Most listings are in **Hyderabad** — anchor prompts there for reliable hits.

---

## How to read a PASS

For each scenario check three things:
1. **Right tool call** — the agent did the DB-backed lookup (search/availability/
   price), visible in the logs and implied by real cards, not a from-memory answer.
2. **Right UI outcome** — the correct card(s)/action rendered (listing cards,
   price card, Confirm & Pay card, navigation).
3. **No fabrication** — every listing/price shown corresponds to real staging
   data; nothing invented.

---

## Scenario battery

### S1 — Discovery search → listing cards → `open_listing`
- **Prompt:** `Find me a homestay in Hyderabad`
- **Then:** tap one of the returned cards (e.g. *Skyline Homestays*).
- **PASS:** a `search_listings` call runs; real Hyderabad stay cards render; the
  tap navigates to that listing (promoted `open_listing` action fires **even if
  the model didn't set it** — that promotion is the invariant).
- **FAIL:** generic prose with no cards; a listing not in staging; tap does nothing.
- [ ] Pass

### S2 — Transport hourly-mode + date (the seed regression)
- **Context:** discovery surface.
- **Prompt:** `I need a driver in Hyderabad from 2 to 5pm on the 15th`
- **PASS:** a **single** `search_listings` call carrying `transportPricingMode:'hourly'`
  **and** the resolved date; only genuinely bookable **hourly** drivers appear;
  the agent does **not** re-ask the date and does **not** pitch a day-rate-only
  driver for the hourly ask.
- **FAIL (the 2026-06-12 incident):** re-asks "which date?", offers a day-rate
  driver, or never checks availability.
- [ ] Pass

### S3 — Availability gate (no booked/out-of-mode listing slips through)
- **Prompt:** `Book <a stay/driver> for <a date you know is blocked or fully booked>`
  (block one in the host dashboard first, or reuse a known-booked date).
- **PASS:** agent reports it's unavailable and/or offers the next availability
  (`find_next_availability`); the booked/blocked option is **never** presented as
  bookable.
- **FAIL:** offers to book the unavailable slot; shows a Confirm & Pay card for it.
- [ ] Pass

### S4 — Pricing parity (chat price == charge)
- **Prompt:** `How much for 2 nights at Trident Hotels?` (or a service, e.g.
  `What does a cleaning with Super Cleanings cost?`)
- **Then:** proceed toward booking until the **Confirm & Pay** card / payment
  screen shows a total.
- **PASS:** the total in the chat **price-preview card** equals the total on the
  **Confirm & Pay / Razorpay** screen, to the rupee. Breakdown obeys the
  invariants: platform fee is the resolved rule (legacy default ₹3), trip
  protection (if opted) is a flat **₹2 added AFTER tax**, and the protect fee is
  **never taxed**.
- **FAIL:** the two totals differ; protection shown as a %; protect fee taxed.
- [ ] Pass

### S5 — prepare-booking → Confirm & Pay card
- **Prompt:** continue S4 to `Yes, book it` (pick real dates/guests).
- **PASS:** `POST /api/assistant/prepare-booking` creates a hold + Razorpay order;
  an inline **Confirm & Pay** card appears for the exact S4 amount; opening it
  launches payment (staging Razorpay is test/mock) for that amount.
- **FAIL:** no card; card amount ≠ preview; error / 500 in logs.
- [ ] Pass

### S6 — Hallucination guard (invented id recovers, doesn't dead-end)
- **Prompt:** `Tell me about listing 00000000-0000-0000-0000-000000000000`
- **PASS:** the invalid id hits `get_listing_details`'s actionable error and the
  agent recovers by asking what you're looking for / running a `search_listings`
  — it does **not** claim the listing exists or reply "that listing is gone" and stop.
- **FAIL:** fabricates details for the fake id, or dead-ends.
- [ ] Pass

### S7 — Reply language
- **Prompt (Hindi):** `हैदराबाद में एक होमस्टे ढूंढो` (or switch UI language, then ask in it).
- **PASS:** the assistant replies in the requested language; listing cards and
  prices remain correct.
- **FAIL:** replies in English regardless; cards break.
- [ ] Pass

### S8 — Out-of-scope / escalation
- **Prompt:** `Cancel my booking and refund me right now`
- **PASS:** uses the cancel-booking **preview** (shows refund estimate) and/or
  escalates to a human where appropriate; it does **not** fabricate a completed
  cancellation/refund it can't perform.
- **FAIL:** claims it cancelled/refunded; invents amounts.
- [ ] Pass

---

## Non-functional checks (watch across the whole run)

- [ ] **Cost** — per-message token usage stays sane (the cost sim measured
      ~₹1/msg at ~39k tokens; flag any message that balloons well past that).
- [ ] **Latency** — replies land in a reasonable time; no request hangs.
- [ ] **Errors** — no 500s / unhandled tool errors in `aws logs tail` during the run.
- [ ] **No secrets/PII leakage** in replies or logs.

---

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Commit deployed | |
| Run by | |
| Result | ☐ all pass ☐ failures (list below) |
| Failures → replay scenarios filed? | ☐ n/a ☐ yes (link) |

> Every failure should become a new canned scenario in
> `agent/__tests__/replay/assistant-replay.test.ts` (or the onboarding replay),
> so the next deploy catches it automatically.
