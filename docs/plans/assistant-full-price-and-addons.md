# Implementation Plan — Assistant: complete price lists + oral add-on offers

> **Status:** WS1 ✅ · WS2 ✅ · WS3 ✅ · WS4 ✅ — all implemented + tested.

## Problem (confirmed from production screenshots)

1. The AI assistant quoted Men's (₹700) + Kid's (₹396) haircut but **silently dropped Women's
   (₹1,200)** — a variant that demonstrably exists in the listing's `metadata.servicesCatalog`.
2. The per-variant **add-ons** (Blow Dry +₹300, Hair Wash +₹147) were never offered at all.

The data is fully available: `get_listing_details` returns `serviceCatalog`, listing-level
`addOns`, and a normalized `priceableOptions` menu (with per-variant add-ons nested). The failure
is downstream — the model truncates, and the existing safety nets don't cover the observed cases.

## Root cause (traced)

- A deterministic **full-menu backstop** already exists
  (`server/src/modules/chat/services/full-menu-backstop.ts`) to re-append dropped options, BUT it
  only fires when `get_listing_details` ran **on the same turn** as the partial reply
  (`user-assistant.service.ts:857`). Cross-turn re-quoting (model recalling prices from context a
  turn later) and search-only answers bypass it.
- Its intent detector (`isFullMenuIntent`) covers English + transliterated Hindi but **not native
  script** (the screenshot was Telugu), so the "user asked for the full list" branch can't fire for
  the observed language.
- Add-ons are held until "after the user picks a slot" by the prompt, and only surface via the
  backstop — which never fired. So at the quote moment, add-ons are invisible.

## Decisions (from product)

- **Full-list / "tell me more" intent** → display every variant **with its add-ons inline**.
- **Direct variant request** ("I want a men's haircut") → offer add-ons **orally**, timing left to
  the model.
- **Enforcement: deterministic gate** — the server must guarantee an add-on offer happens before a
  service-with-add-ons booking can be created. Not prompt-only.
- **Always confirm** — even if add-ons were shown inline earlier or agreed verbally, there is one
  explicit add-on resolution step before booking.
- **Oral only — NO confirmation card.** The offer/confirmation is a chat exchange, modelled on the
  existing `room_required` flow, not the caste-affirmation card.

---

## Workstream 1 — De-scope the full-menu backstop from "this turn"

**Goal:** a partial price list gets completed even when `get_listing_details` ran on an earlier
turn (the screenshot case).

1. **New cache module** `server/src/modules/chat/agent/recent-priceables.ts`, mirroring
   `recent-hits.ts` (same Redis client, same best-effort try/catch, ~30-min TTL).
   - Key: `assistant:listing-priceables:${userId}:${listingId}`
   - Value: the `priceableOptions` array from `get_listing_details`.
   - Per-listing keyed (not a capped merged list) for exact recall of the focus listing.

2. **Write on every details fetch.** In `get-listing-details.tool.ts`, beside the existing
   `recordRecentHits(...)` call (~line 411), add
   `recordListingPriceables(ctx.userId, listing.id, priceableOptions)`. Best-effort, never throws.

3. **Add a cache fallback to the backstop.** In `user-assistant.service.ts` (~line 857), change the
   `priceableOptions` resolution order to:
   - (a) this-turn `get_listing_details` result (current behavior), else
   - (b) cached `priceableOptions` for the **focus listing** = most-recent id from
     `readRecentHits(userId)[0]` (or the `open_listing` action target if one fired this turn).

   The existing `quotedCount >= 2` branch then catches the screenshot case with **zero language
   logic**: the reply quoted ₹700 + ₹396 (count = 2), Women's price absent → appended.

**Safety:** `appendMissingMenuOptions` dedups by price-presence, so re-firing can't double-list.
Server-side text mutation → mobile inherits the fix, no client change.

---

## Workstream 2 — Language-agnostic full-menu intent

Once WS1 lands, the **partial-list** case (≥2 prices quoted) is already language-agnostic. The
residual gap is the **single-variant-quoted + "show me everything"** case, which still needs intent
detection.

1. **Extend `isFullMenuIntent`** (`full-menu-backstop.ts:23`) with native-script keyword sets:
   Telugu (ఇంకా ఏమైనా / పూర్తి / అన్ని), Devanagari Hindi (और क्या / सब / पूरा), Tamil, etc.
2. **Document the residual** in the comment: an un-listed native-script phrasing with only one price
   quoted still falls back to the model. Acceptable — the high-frequency failure (partial
   enumeration) is now closed structurally by `quotedCount` in WS1.

---

## Workstream 3 — Deterministic oral add-on gate (no card)

**Pattern:** model `room_required` (`prepare-booking.tool.ts:252`) — server refuses, returns a
`userMessage` the model quotes orally, user answers in chat, model retries. No UI surface.

1. **Gate in `prepare_booking` / `assistant-booking.service`.** The service already loads the
   listing to price it, so it can compute the chosen variant's available add-ons (from
   `serviceCatalog[serviceCatalogId].addOns` plus listing-level `addOns`). Add a check, evaluated
   before the hold/order is created:

   > IF listing is a service AND the chosen variant (or listing-level) has ≥1 available add-on AND
   > `serviceAddOnIds` was **not provided** (undefined) → return
   > `{ success:false, reason:'addon_offer_required', userMessage, addOns:[{id,label,price}], retryArgs }`.

   - `addOns` echoes the offerable extras for the chosen variant.
   - `retryArgs` echoes the booking args (same shape as `caste_affirmation_required`'s echo) so the
     next call is a clean retry.
   - New `FailureReason` value `'addon_offer_required'` added to the union (~line 184).

2. **Resolution signal = `serviceAddOnIds` becomes defined.**
   - User picks extras → model retries with `serviceAddOnIds: [ids]`.
   - User declines → model retries with `serviceAddOnIds: []` (explicit empty = "asked, declined").
   - Either way `serviceAddOnIds` is now defined → gate passes, booking proceeds.

3. **No new model-faked flag.** Unlike the caste flag, there's no card to set an un-fakeable signal,
   so the resolution rides on `serviceAddOnIds`. The gate guarantees a *value* is present; the
   prompt guarantees the model *asks first* (see Prompt changes). This is the honest determinism
   level for an oral, card-less flow — documented as such.

4. **"Always confirm" holds.** Inline display (full-list path) and verbal agreement both set at most
   `serviceAddOnIds` via the model's own arg on the *first* attempt — but the model is instructed
   NOT to pre-populate `serviceAddOnIds` until it has explicitly offered and the user has answered
   (Prompt changes). So the first `prepare_booking` for a service-with-add-ons trips the gate, the
   model offers orally, and only the post-offer retry carries the resolution.

---

## Prompt changes (`user-assistant.service.ts` system prompt)

- **Full-menu / "tell me more":** when enumerating `priceableOptions`, **include each option's
  add-ons inline** (lift the current "hold add-ons until slot pick" restriction for the full-list
  path only).
- **Service booking flow:** before calling `prepare_booking` for a service whose chosen variant has
  add-ons, **offer the add-ons orally** ("Women's Haircut is ₹1,200 — want to add Blow Dry +₹300 or
  Hair Wash +₹147?") and wait for an answer. Pass `serviceAddOnIds` only AFTER the user has
  responded: chosen ids, or `[]` if they declined. **Never pass `serviceAddOnIds: []` without having
  offered.**
- **`addon_offer_required` handling:** like `room_required` — quote `userMessage`, list the echoed
  `addOns`, ask, do NOT retry until the user answers, then retry with `serviceAddOnIds`.

---

## Tests

`full-menu-backstop.test.ts`:
- Cross-turn repair: no `get_listing_details` this turn, cache has all 3 variants, reply quotes 2 →
  Women's appended. (Direct regression for the screenshot.)
- Native-script intent: Telugu "tell me more" + single price → full menu appended.
- Add-on inclusion: full-menu fire includes per-variant add-on lines.
- No double-append: reply already lists all 3 → unchanged.

`recent-priceables.ts`: write→read round-trip; best-effort no-throw on Redis error.

`prepare-booking.tool.test.ts` (+ `assistant-booking` service test):
- Service with add-ons + `serviceAddOnIds` undefined → `reason:'addon_offer_required'` with echoed
  `addOns` + `retryArgs`.
- Retry with `serviceAddOnIds:[]` → proceeds (no re-gate).
- Retry with chosen ids → proceeds, priced correctly.
- Variant with no add-ons → gate does NOT fire.

Run: `cd server && npm run build` and the touched module tests.

---

## Sequencing & risk

1. **WS1** — fixes the screenshot alone (cross-turn cache + existing `quotedCount`). Lowest risk:
   additive cache, dedup-safe append, server-side only.
2. **WS3** — booking-path gate. Higher care: touches `prepare_booking` (high-risk module). Mirrors
   an existing reason/echo/retry pattern; covered by tests above. Verify mobile assistant path
   quotes the new `userMessage` (oral — no client UI needed).
3. **WS2** — native-script keywords. Lowest urgency; nice-to-have for the single-quote tail.

## Files touched

- `server/src/modules/chat/agent/recent-priceables.ts` (new)
- `server/src/modules/chat/agent/tools/get-listing-details.tool.ts` (write cache)
- `server/src/modules/chat/services/user-assistant.service.ts` (backstop fallback + prompt)
- `server/src/modules/chat/services/full-menu-backstop.ts` (native-script intent)
- `server/src/modules/chat/agent/tools/prepare-booking.tool.ts` (new reason + gate echo)
- `server/src/modules/chat/services/assistant-booking.service.ts` (gate logic)
- Tests as listed above.

## Out of scope / explicitly NOT doing

- No add-on confirmation **card** on web or mobile — the offer is oral only.
- No change to the pricing math (`applyFees` / `computeBookingFees`) — add-ons already price
  server-side from real ids; this plan only changes *when they're offered*, not how they're priced.

---

# WS4 — Close the upstream gap: the model never calls `get_listing_details`

## Problem (second screenshot, plain-English "tell me more")

Turn 1: "I want a haircut" → "There's a Truefitt & Hill in Banjara Hills that offers haircuts."
(search only — no details fetch). Turn 2: "tell me more about it" → "men's haircut is ₹700, and
they also offer beard trims and shaves." Dropped Women's (₹1,200), Kid's (₹396), and every add-on.

**WS1–3 do not catch this.** The full-menu backstop can only append options it can *find*, and it
finds them only in (a) this turn's `get_listing_details` result or (b) the WS1 priceables cache —
which is populated *only* by `get_listing_details`. Here the model **never called
`get_listing_details` on any turn**, so both sources are empty and the backstop has nothing to
append. WS2 is irrelevant — "tell me more about it" already matches `isFullMenuIntent`; there were
simply no options for it to act on.

## Root cause (confirmed by prompt trace)

The reply is fully reconstructable from the **search hit alone**: `SearchHit` carries a single
`price` (₹700) + a `subcategories` array (["Haircut","Beard trim","Shave"]). The per-variant catalog
+ add-ons live ONLY in `priceableOptions` from `get_listing_details`. The prompt fails to force the
call:

- The strong "enumerate EVERY `priceableOptions`" rule is in the `get_listing_details` **tool
  description** (`user-assistant.service.ts:234`) — it says what to do *with the result*, presupposing
  the model already chose to call the tool. Nothing makes the call itself mandatory.
- The pricing-reveal instruction (`:261`) is soft — "reveal the real prices ... via
  `get_listing_details`" — and the model reads "I already have a real price" (the search hit's
  `price`) as satisfying it.
- The search-presentation example at `:261` ("Truefitt & Hill ... they do haircuts, beard trims, and
  shaves") literally models answering from `subcategories` without details; the model pattern-matched
  it for "tell me more" (the reply is nearly verbatim).
- The detailed full-enumeration rules (`:343–345`) live INSIDE the post-gate **booking flow**. "Tell
  me more" is a pre-booking info question that never trips the gate, so the model isn't "in the flow"
  and never reaches them.

Net: the model has a local incentive to skip the tool (it already holds *a* price + a service list),
and the prompt doesn't override it. Prompt-strengthening alone is fragile — same failure class as
add-on offering — so WS4 is two-pronged: a prompt rule AND a deterministic self-fetch.

## Part A — Deterministic self-fetch (the guarantee)

Make the backstop fetch `priceableOptions` itself, so completeness no longer depends on the model
calling the tool.

1. **Extract the builder.** The `priceableOptions` computation is currently inline in
   `get-listing-details.tool.ts` (~lines 333–394: rooms / service variants / transport modes +
   service-wide add-ons → normalized list). Lift it into a shared pure helper, e.g.
   `server/src/modules/chat/agent/priceable-options.ts`:
   `buildPriceableOptions(listing: Record<string, unknown>): PriceableOptionLite[]`.
   `get-listing-details.tool.ts` then calls the helper instead of its inline block (behavior-preserving
   refactor — its existing output must be byte-identical; assert with its current tests +
   `service-variant-pricing.integration.test.ts`).

2. **Self-fetch in the backstop.** In `user-assistant.service.ts`, extend the WS1 fallback chain with
   a final step: when `isFullMenuIntent(lastUser)` is true AND a focus listing id is resolvable (top
   of `recentHits`, or an action target) AND no `priceableOptions` came from this turn OR the cache,
   then `listingsService.getById(focusId)` → `buildPriceableOptions(listing)` → cache it
   (`recordListingPriceables`, so later turns are warm) → run the append. Best-effort try/catch; a
   fetch failure leaves the message untouched (never break the turn).

   Resolution order becomes: (a) this-turn tool result → (b) WS1 cache → (c) self-fetch. Only (c) is
   new. Gate the self-fetch on `isFullMenuIntent` specifically (not the `quotedCount>=2` branch) so we
   only pay a DB read when the user actually asked for the full picture — not on every service reply.

3. **Why this is the real fix:** it makes the full menu model-independent. Whether the model called
   `get_listing_details`, paraphrased from the search hit, or forgot entirely, a "tell me more" about
   a focus listing now always completes from authoritative data.

## Part B — Prompt rule (necessary, not sufficient)

In `user-assistant.service.ts`, add ONE unconditional, prominent rule in the **discovery/info**
section (NOT the booking flow), and neutralize the misleading example:

- New rule: *"Any request for details about a specific listing — 'tell me more', 'what do they
  offer', 'how much', 'what services / rooms / modes' — MUST be preceded by a `get_listing_details`
  call, and your reply MUST enumerate the full `priceableOptions` (every variant/room/mode + its
  add-ons). The search hit's single `price` + `subcategories` are a TEASER, never sufficient to
  answer 'tell me more' — answering from them is the bug."*
- Tighten the `:261` example so it's clearly the *suggestion* phrasing (no prices, pre-pick), and add
  an explicit contrast: once the user engages one listing, switch to the details path.

## Tests (WS4)

- `priceable-options.ts`: a focused unit test feeding a salon listing (servicesCatalog Men's/Women's/
  Kid's + per-variant add-ons + listing-level add-ons) → asserts the full normalized list. Reuse the
  fixture shape from the WS3 service test.
- Refactor safety: `get-listing-details.tool` existing tests still green (output unchanged).
- Backstop self-fetch: a service test where NO `get_listing_details` ran this turn AND the cache is
  empty AND `isFullMenuIntent` is true → the backstop calls `getById`, builds options, and appends
  the dropped variants. Mock `listingsService.getById`.
- Guard: a single-variant price question (`isFullMenuIntent` false) does NOT trigger a self-fetch
  (assert `getById` not called) — no needless DB read.

## Risk / sequencing

- **Part A is the load-bearing change**; Part B reduces how often A has to fire.
- The extraction is behavior-preserving — the only way it breaks is if the lifted code diverges from
  the inline original, which the existing `get-listing-details` tests catch.
- One extra DB read per "tell me more" when the model skipped the tool — acceptable and self-limiting
  (gated on `isFullMenuIntent`, cached after first fetch).

## Files touched (WS4)

- `server/src/modules/chat/agent/priceable-options.ts` (new — extracted builder)
- `server/src/modules/chat/agent/tools/get-listing-details.tool.ts` (call the helper)
- `server/src/modules/chat/services/user-assistant.service.ts` (self-fetch fallback + prompt rule)
- Tests as listed above.
