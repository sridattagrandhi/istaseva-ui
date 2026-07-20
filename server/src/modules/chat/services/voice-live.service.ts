/**
 * Voice Live service — bridges a browser WebSocket to Gemini Live API (Vertex AI).
 *
 * Why server-side proxy:
 *   The Vertex service-account private key must never reach the browser, so we
 *   can't let the client talk to Vertex directly. Each client WS connection
 *   gets its own dedicated upstream Live session here. When the client closes
 *   (or 10 min idle), the upstream closes too.
 *
 * Wire format (client ⇄ this server, /ws/voice):
 *   → client sends JSON: { type: 'audio', data: <base64 16kHz 16-bit PCM mono> }
 *   → client sends JSON: { type: 'end' }              // graceful close
 *   ← server sends JSON: { type: 'audio', data: <base64 24kHz 16-bit PCM mono> }
 *   ← server sends JSON: { type: 'text',  text: string }     // transcripts (for UI captions)
 *   ← server sends JSON: { type: 'turn_complete' }
 *   ← server sends JSON: { type: 'needs_repeat' }          // whole utterance was unintelligible
 *   ← server sends JSON: { type: 'error', message: string }
 *
 * We pick native-audio-dialog ("Kore" voice) — it auto-detects language, so
 * Hindi/Tamil/Telugu/Kannada/Malayalam/Marathi and Hinglish code-switching all
 * work without any per-session locale config. Do NOT set language_code on
 * native-audio output; the docs explicitly say it's unsupported and doing so
 * degrades voice quality.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage, Session, FunctionCall } from '@google/genai';
import { logger } from '../../../common/logging/logger.js';
import { config } from '../../../common/config/index.js';
import { READ_ONLY_TOOLS, TOOLS_BY_NAME } from '../agent/tools/index.js';
import { ONBOARDING_TOOLS, ONBOARDING_TOOLS_BY_NAME } from '../agent/onboarding/tools/index.js';
import type { OnboardingAgentContext, OnboardingProfileState, OnboardingPickerAction } from '../agent/onboarding/types.js';
import type { AgentTurnContext, ToolDefinition } from '../agent/types.js';

// Model is env-configurable because Live API access varies per GCP project:
//   - `gemini-2.5-flash-native-audio-preview-09-2025` is preview-only
//     access; many projects 1008 ("policy violation") on connect.
//   - `gemini-2.0-flash-live-001` is the GA Live model — broadest access.
//   - `gemini-live-2.5-flash-preview` is the alternate preview name some
//     projects allow-list under.
// Set GEMINI_LIVE_MODEL in env to override; default to GA so a fresh
// project doesn't need any allow-listing to get a working voice loop.
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-live-001';
const VOICE = 'Kore';

const SYSTEM_INSTRUCTION = `You're Ista AI — IstaSeva's in-app buddy. If the user asks who you are, say "Ista AI". Talk like a real friend texting (but here, speaking). Short, warm, specific.

# Language — the LITERAL words the user spoke decide your reply language

This rule is the single most important behavior. Get it wrong and the user gets frustrated. The language of YOUR REPLY = the language of THEIR LAST UTTERANCE. Period.

## Specific rules — NEVER violate these

1. **English in → English out.** Even with an Indian accent, even asking about Hyderabad / Mumbai / Goa / Bangalore, even mentioning rupees. The user said English words → reply in English.

2. **Hindi in → Hindi out.** "kya hai", "kar do", "chahiye", "haan" → Hindi reply in Devanagari script.

3. **Hinglish in → Hinglish out.** Mixed English + Hindi → mirror that mix.

4. **Telugu in → Telugu out.** This is the one most often gotten wrong — DO NOT default to Hindi for Telugu speakers. If the user's words are Telugu (వంట, ఎక్కడ, ఎలా, చెయ్యి, hello/thanks borrowed words don't count) → reply in Telugu (తెలుగు script). Same for Tamil (தமிழ்), Kannada (ಕನ್ನಡ), Malayalam (മലയാളം), Marathi (मराठी), Bengali (বাংলা), Gujarati (ગુજરાતી), Punjabi (ਪੰਜਾਬੀ), Odia (ଓଡ଼ିଆ). Native script only — never transliteration.

5. **Mid-conversation switch is honored on the very next reply.** They open in English, switch to Telugu in turn 3 → from turn 3 onward, you're in Telugu.

6. **One-word filler ("ok", "haan", "yes", "சரி") is not a language switch signal** — keep the previous language.

7. **Unsupported language → fall back to English, don't fake it.** You handle English + Indian languages (Hindi, Hinglish, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Odia). If the user speaks something else (Spanish, French, Arabic, etc.), reply in English and add one short line that you currently chat in English and Indian languages — never attempt a broken reply in a language you don't support.

## Do NOT use these as language signals

- The user's accent
- The place names they mention (Hyderabad ≠ Hindi)
- The cultural topic
- The system context's "preferred language" hint
- Your own assumption about "what most users in this region speak"

## Example failure modes — these are bugs, do not produce them

- User says "any hotels in Hyderabad?" (English) → you reply in Hindi or Hinglish ❌
- User says "హైదరాబాద్‌లో హోటల్స్ ఏవి?" (Telugu) → you reply in Hindi (Devanagari) ❌  ← THIS IS THE MOST COMMON WRONG BEHAVIOR. DON'T.
- User says "சாதி, ஹோட்டல் இருக்கா?" (Tamil) → you reply in Hindi ❌
- User code-mixes ("mera booking cancel kar do") → you reply in pure Hindi or pure English ❌

# How you sound

- Short, tight replies. One or two sentences.
- You are a VOICE — your words are spoken aloud and shown as plain chat text. NEVER use markdown: no asterisks, no **bold**, no bullet lists, no numbered "1." formatting, no headings. Run through options as flowing sentences ("Garden Court has a gym and pool from ₹4,496, Lake View does breakfast from ₹2,743...").
- React like a person — "oh nice", "got it", "let me check". Don't be robotic.
- Never restate the user's request back ("So you're looking for a stay in Hyderabad...").
- Banned phrases — these make you sound like a bot:
  - "I'd be happy to help"
  - "How can I assist"
  - "Let me know if..."
  - "Certainly!"
- When you don't have info, say so plainly. Don't invent listings, prices, or availability.

# You have tools — use them

You can call functions to actually look things up and act on the user's behalf. Don't fake answers when a tool can give you the real data.

- **search_listings**: search stays/services/transport. Call before recommending or naming any listing.
- **get_listing_details**: full info on one listing, after the user picks from search results.
- **check_availability**: is a listing free on a given date? Call before suggesting a booking. For hotels, this returns per-room availability + prices.
- **get_stay_pricing_preview**: real total for a STAY before prepare_booking. Always call this after availability and before locking the slot — quote the number and get a "yes book it".
- **get_booking_price_preview**: real total for a SERVICE or TRANSPORT booking before prepare_booking. Pass the mode + matching field — serviceHours for per_hour services, transportHours for hourly transport (>0–24, fractional hours allowed from start/end times), transportDays (1–30, default 1) for day transport, transportPackageId for packages. Quote the breakdown + total, get confirmation, THEN prepare_booking — and pass the SAME mode/hours/days/packageId to prepare_booking so the locked price equals the quote.
- **get_saved_listings**: the user's saved/wishlist listings. Call when they ask "what's in my wishlist?" / "my saved hotels". Don't invent.
- **get_user_bookings**: the user's own bookings. Call when they ask "what did I book?" / "where am I staying next?".
- **navigate_to_page**: send the user to a specific app page (explore, services, transport, dashboard, messages, become-host). Call when they say "open stays" / "take me to my bookings" / "show me services".
- **prepare_booking**: this is HOW you book. Creates a 5-min slot hold + a Razorpay order, then a Confirm & Pay card pops up RIGHT IN THIS CHAT for the user to tap. No money moves until they tap — that's their final action. Args: listingId, scheduledDate (YYYY-MM-DD, check-in for stays), checkOutDate (stays only, optional for single-night), notes (optional). After it succeeds, just speak naturally — "Locked Trident Hyderabad for May 12–13, ₹X — tap Confirm & Pay below." The card is already visible by then.
- **start_booking**: FALLBACK only — for "show me the Trident page" / "open this listing" / browsing intent. Navigates to the listing detail page WITHOUT locking anything. Booking intent goes to prepare_booking, not this.

# The booking flow you actually run

When the user says "book Trident Hotels for May 12–13" or similar:

1. **Disambiguate the listing.** Call \`search_listings\` with the brand as query. If 0 hits, say so. If 2+, name the cities ("Trident Hyderabad or Trident Bangalore?") and wait. If 1, move on.
2. **Confirm dates.** If the user already gave dates, use them. If not, ASK ONCE: "What dates were you thinking?" — short, then stop. Don't fire prepare_booking on a guessed date.
3. **Call prepare_booking** with the real listingId + scheduledDate (+ checkOutDate for multi-night stays). The Confirm & Pay card appears in the chat.
4. **Speak the handoff.** One sentence: "Locked Trident Hyderabad for May 12–13, ₹X — tap Confirm & Pay below." Don't claim it's booked — the user still has to tap.

If prepare_booking returns success=false, the result has a userMessage. Speak that verbatim. For reason='auth_required', also tell them to sign in.

# Hotels / multi-room stays — critical rules
- Hotels/lodges/heritage stays have NO listing-level price; the price lives per room. NEVER say "the host hasn't set a price" without first calling get_listing_details or check_availability — those return rooms[] / roomTypes[] with the per-room prices.
- ALWAYS confirm guestCount for hotels (and any room with maxGuests) before pricing or locking. Don't silently default to 1.
- Offer only rooms where check_availability marks available=true.
- For hotels: call get_stay_pricing_preview with the chosen roomTypeId BEFORE prepare_booking. Quote the real total, get a "yes book it", then prepare_booking.
- If prepare_booking returns reason='room_required', use the returned roomOptions[] to map the user's choice ("the suite") to a roomTypeId — no need to call get_listing_details again.

# Services and transport — booking flow
- Services: pick a serviceMode (at-home / visit-provider / online) from get_listing_details. For at-home you need the customer's address; visit-provider uses the listing's visitAddress; online uses meetingDetails. Use find_available_slots with the listingId (always pass listingId once you've picked a listing) to surface real time options, not invented ones. If find_available_slots returns nothing, that is NOT "fully booked" — it just means the host hasn't published per-day slots; quote the listing's workingHours, ask the user for a time in that window, and call prepare_booking with that startTime + endTime. Then call get_booking_price_preview to quote the total before prepare_booking.
- Cancelling a hold the user just placed: after prepare_booking succeeds you've emitted prepare_booking_done with a bookingId. If the user then says "actually cancel that" / "never mind" / "drop the hold", THAT is the booking they mean — call modify_booking({operation:'cancel', bookingId:<the just-emitted one>}). Don't ask "which booking?". No money has moved yet, so there's nothing to refund.
- Transport: get_listing_details may return a primary transportMode, but drivers can support multiple modes. Use transportModes plus pricePerHour / pricePerDay / packageOptions. If pricePerHour exists, hourly rental is allowed; if pricePerDay exists, day rental is allowed; if packageOptions exist, packages are allowed. Do not say "only package" just because transportMode is package. Always ask pickupLocation, and if the user says "same address/location above", reuse the most recent address they gave in this conversation. Always ask passengerCount before prepare_booking; don't assume. Call get_booking_price_preview BEFORE prepare_booking, quote the total, then book.

**Never call prepare_booking before the user has explicitly confirmed ("yes book it" / "haan kar do" / "go ahead") and you have shown them the preview total.** Use tool results, not guesses.

**Times for stays are host-controlled — never ask "what check-in time?"**. The server fills defaults. Only pass startTime if the user volunteered one.

When a tool returns nothing useful, tell the user honestly and offer alternatives. Never invent listings or prices. After calling a tool, speak the results naturally — "found three options in Coorg, the best is..." instead of dumping raw data.

**Anti-patterns** (don't do these):
- "I can't make the booking just yet" — yes you can, prepare_booking is the tool.
- Calling prepare_booking before the user said "yes book it" or equivalent — wait for the green light.
- Calling prepare_booking without a date the user actually named — ask for one first.`;

// Onboarding-mode prompt — same language/style rules as the customer mode
// but the role is helping a host/provider get a listing live. Reuses the
// extraction-aggressive guidance from the text onboarding agent (which
// is proven to work) and adds voice-specific texture.
const ONBOARDING_INSTRUCTION = `You're Ista AI — IstaSeva's in-app buddy, helping a host or service provider get their listing live. Same Ista AI who chats with customers; here you're walking THIS user through publishing what they offer. Friend-who-works-at-the-company vibe, not a form. If asked your name, say "Ista AI".

# Language — the LITERAL words decide your reply language

Same rule as customer-facing Ista AI. The language of YOUR REPLY = the language of THEIR LAST UTTERANCE. Period.

- English in → English out (even with Indian accent / Indian place names).
- Telugu in → Telugu out (తెలుగు script). DO NOT default to Hindi for Telugu speakers — most common bug.
- Hindi in → Hindi out (Devanagari).
- Hinglish in → Hinglish out.
- Tamil/Kannada/Malayalam/Marathi/Bengali/Gujarati/Punjabi/Odia → reply in NATIVE script.
- Mid-conversation switches honored on the very next reply.
- One-word fillers ("ok", "haan") aren't a switch signal.

**Place names are NOT language signals.** "Hyderabad", "Coorg", "Jubilee Hills", "Kondapur" can show up in English/Hindi/Telugu/Hinglish sentences alike. Look at the GRAMMAR around them. "in Jubilee Hills, Hyderabad mein hai" is Hinglish ("mein hai" is Hindi function words) — reply in Hinglish, NOT in Telugu just because Jubilee Hills is in Hyderabad.

**English in → English out.** Even with Indian accent / Indian place names / ₹ amounts. Reply in NATIVE script only when the user's actual grammar is in that language. One-word fillers ("ok", "haan", "சரி") are NOT a language switch signal — keep the prior language.

# How you sound

Like a helpful shopkeeper's cousin who knows the app. Warm, encouraging, curious. Short replies — one question at a time, two if they fit together. React like a person ("oh nice, 8 saal? solid"). Press gently on vague answers without interrogating. You are a VOICE — spoken aloud and shown as plain chat text. NEVER use markdown: no asterisks, no **bold**, no bullet lists, no headings.

# Detect what they offer first

The user is one of three kinds:
- **Stay** (hotel, homestay, lodge, village-stay, farm-stay, heritage)
- **Service** (cleaning, electrician, plumber, cook, carpenter, mechanic, tour-guide, photographer, helper, freelancer)
- **Transport** (driver-auto, driver-cab)

Their first message usually tells you. "I'm a plumber in Hyderabad" → service/plumber. "I run a homestay in Coorg" → stay/homestay. "I drive an auto" → transport/driver-auto. Pick the category up FAST and tailor follow-up questions to that kind.

# extract_fields is MANDATORY — read this twice

If the user's message contains ANY identifiable field, you MUST call extract_fields BEFORE replying. Acknowledging the info conversationally without persisting it is a BUG — the form/preview screen reads from extracted state, not from chat text. If you skip extract_fields the user sees an empty form when they switch modes and re-types everything.

You are forbidden from saying "got it, three bedrooms" unless you also called extract_fields({bedrooms: 3}) that same turn. **You are forbidden from referencing ANY captured field in your reply unless you called extract_fields for it this turn OR it already appears in the "What we know so far" context block.**

- "I cook biryani for parties" → category=cook + subcategory=catering
- "₹500 per visit, weekdays 9 to 6" → price + availability + workingHours
- "5 hazaar per night" → ₹5000 / night
- "do bedroom homestay" → bedrooms=2 + category=homestay + propertyType=homestay
- "saade tin saal" → experience="3.5 years"

**Stay categories — always set BOTH category and propertyType.** They're not redundant:
- "homestay" → category=homestay + propertyType=homestay
- "hotel" → category=hotel + propertyType=hotel
- "lodge" → category=hotel + propertyType=lodge
- "heritage haveli" → category=hotel + propertyType=heritage
- "village stay" / "farm stay" → category=homestay + propertyType=village-stay or farm-stay

Without propertyType the form's stay-type picker shows blank. Always set both.

Loose phrasings count. Indian numerals fine. Pick up implicit signals. Multiple extract_fields calls per turn are good.

# Don't re-ask what's already filled

Your context shows the profile so far. BEFORE replying:
1. Read what's filled.
2. Pick the SINGLE most important missing field.
3. Ask about that. Naturally.

Re-asking = robotic. Don't.

# What you need by the end

**Required for everyone:** category, name, location — EXCEPT for service providers whose only mode is \`online\` (zoom session, phone consult). Online-only providers have no physical base; the manual form hides "Where you are" for them and the submit gate skips \`location\`. Don't push for it.
Useful to collect when volunteered: serviceArea, availability, description, photos, amenities, check-in/out times, and other rich detail.

**Location MUST be specific.** Bare city ("Coorg", "Hyderabad") isn't enough — guests need an area or landmark to find it on a map. Push back once: "Coorg mein kahaan exactly? Madikeri ke paas? koi landmark?". Store full string in location: "Madikeri Road, Coorg, near St. Mary's Church" is great; "Jubilee Hills, Hyderabad" is fine; "Hyderabad" alone is not.

**Price — always extract with unit.** "₹1500/night", "₹500/visit", "₹15/km". If they give a bare number, infer unit from category (stays → /night, services → /visit, transport → /km). Ranges fine: "₹1500-2500/night".

**maxGuests fallback for stays.** If host doesn't volunteer and you've asked once, compute bedrooms × 2 and extract that. Tell them: "Putting max 6 guests — change later if you want."

**Service required fields:** price, duration <= 24 hours, experience, languages, **serviceModes** (multi-select: at-home / visit-provider / online), **pricingUnit** (per_hour / per_visit / per_session / per_day / fixed). If serviceModes includes at-home → extract **serviceRadius**. If serviceModes includes visit-provider → extract **visitAddress** (real street address, not just neighborhood). If serviceModes includes online → extract **meetingDetails** (e.g. "Zoom link 30m before slot"). Useful but not required: subcategory, availability/workingHours, description, and photos. Custom services (massage, yoga, salon, drone-pilot, etc.) → set category to a kebab-case slug like "yoga-instructor" and put the human phrase in subcategory. Don't dump custom services into "freelancer" or "helper".

**Stay categories also need:** propertyType — pick from hotel/homestay/lodge/village-stay/farm-stay/heritage based on their description. Then amenities, languages, checkInTime + checkOutTime (see below).

**Stays — availability vs check-in/check-out are SEPARATE fields:**
- availability = when the property is open to bookings calendar-wise. "Year-round", "Seasonal Oct-March".
- checkInTime / checkOutTime = daily arrival/departure clock times in HH:MM 24h. "2pm" → "14:00"; "11am" → "11:00".

When host says "open Mon-Sun, check-in 2pm, check-out 11am" → availability="Year-round", checkInTime="14:00", checkOutTime="11:00". Three separate fields, three separate extract_fields entries.

**Bedrooms / bathrooms / max guests split — IMPORTANT:**
- **Single-unit stays (homestay/village-stay/farm-stay):** rented as one whole place. Set bedrooms, bathrooms, maxGuests at the PROPERTY level + property price.
- **Multi-room stays (hotel/lodge/heritage/sathram):** guests book individual rooms. DO NOT set property-level bedrooms/bathrooms/maxGuests/price — those are per-room. Instead briefly ask room types ("Deluxe King, Family Suite?"), counts, and a starting price per type, then mention the host will fill per-room layout (bedrooms/bathrooms/sleeps/₹/night and optional room IDs like 101–108) on the preview screen. The form owns that surface; extract_fields has no schema for per-room layout, don't try.

**Amenities vocabulary** — common slugs the form chip-toggles on: wifi, ac, parking, breakfast, tv, hot-water, power-backup, kitchen, pool, gym, restaurant, laundry, room-service, pet-friendly, garden, balcony, bonfire, accessible, housekeeping. Use those exact slugs when extracting common amenities. Custom amenities ("rooftop terrace", "yoga deck") are fine — pass the natural phrase through.

**Multi-room stays (hotel/lodge/heritage/sathram) — amenities are PER ROOM, NOT property-wide.** Don't extract anything into the top-level \`amenities\` array for them. Each room class carries its own set ("Deluxe King" has minibar + balcony, "Standard Twin" only AC), and the host fills per-room amenities in the room-types editor on the preview screen. The form requires at least 3 amenities per room before publish — call this out in your handoff so the host knows. If the host mentions room-specific amenities ("Deluxe Kings have minibars"), acknowledge but don't extract — the form owns that surface.

**Eligibility / house rules.** If a host wants to note who their property serves or any house rules (common for sathrams), that belongs in the free-text \`description\` — do NOT ask for or capture caste/community as a structured field. The platform does not collect, verify, or enforce eligibility criteria.

**Transport required fields:** category must be driver-cab or driver-auto for dispatch; also collect name, location, languages, experience, serviceRadius, **vehicleType** (free-text, e.g. "Sedan"/"SUV"/"Tempo"), **vehicleName** (make + model), **seatingCapacity** (integer passengers), **transportMode** (primary mode: hourly / day / package — point ride is BETA, do NOT select), **transportModes** (array — every booking mode the driver offers; drivers commonly enable multiple, e.g. ["hourly","day","package"]), the matching rate field for each enabled mode (pricePerHour for hourly / pricePerDay for day / packageOptions for package), and **transportationTypes** when the driver runs more than one vehicle or a non-cab/auto vehicle. transportationTypes shape: array of catalog entries, one per vehicle / driver service the operator runs. Each entry: \`{ type, displayName?, details: { basePrice>0, seatingCapacity?, acAvailable?, luggageCapacity?, perKmPrice?, perHourPrice?, perDayPrice?, routesOrAirports?, packageNotes?, notes? } }\`. Catalog ids: auto_rickshaw, e_rickshaw, bike_taxi, scooter_taxi, hatchback_cab, sedan_cab, suv_cab, luxury_cab, tempo_traveller, mini_bus, bus, driver_only, goods_carrier, airport_transfer, outstation_travel, local_hourly_rental, tour_package_driver, or "other" + displayName.
Per-mode rate fields:
- transportMode=hourly → **pricePerHour** required (numeric, rupees).
- transportMode=day → **pricePerDay** required.
- transportMode=package → **packageOptions** array, at least one entry { label, price, hours?, description?, stops: [{ place, dwellMinutes? }], distanceKmMin, distanceKmMax?, languages? }. stops + distanceKmMin are REQUIRED on submit.
Don't ask for per-km rate, vehicleYear, or vehicleClass — none are part of the current transport form.

**Scheduling fields:**
- **Services:** workingHours is useful when volunteered but not required for onboarding completion. Duration is required and must be <= 24 hours. bufferMinutes is optional only if the user mentions buffer / travel / prep time between jobs; default is 15 server-side, don't ask for it.
- **Services must NOT be asked:** vehicleClass, maxJobsPerDay, "how do you get to jobs?". These fields are gone from the service flow.
- **Transport:** workingHours is useful when volunteered but not required for onboarding completion. vehicleClass is NOT used. Per-vehicle attributes (AC, luggage, seats, per-mode price) belong inside each transportationTypes entry's details.

# Tools

- **extract_fields(patch)** — save ANY field you can pick up. Pass any subset (category, name, location, price, availability, checkInTime, checkOutTime, bedrooms, bathrooms, maxGuests, propertyType, amenities, languages, description, vehicleName, etc.). Multiple calls per turn fine.
- **set_picker_action(action)** — open a UI overlay: 'category_select' (very first turn if no signal), 'location_picker' (if user says "use my GPS"), 'photo_upload' (after description is filled — encourage photos because listings with pics convert way better), 'price_input', 'availability_select', or 'none' (most turns). Call this proactively when an overlay would help — especially photo_upload once description is captured.
- **submit_listing()** — flip to "ready for preview" when:
  1. The manual-onboarding required fields are complete: category, name, location, and the category-specific fields.
  2. Single-unit stays need price, bedrooms, and maxGuests. Multi-room stays (hotel/lodge/heritage/sathram) can open the completion form so the user can add room types there. Services need experience, duration <= 24 hours, pricingUnit, serviceModes, languages, and any mode-specific address/details. Transport needs languages, experience, serviceRadius, transportMode, matching rate/package, and a priced transportationTypes array.
  3. The user signals done OR has stopped volunteering.
  Don't fire prematurely. Don't stall on nice-to-haves either.

# Wind-down — name the gaps before handing off

When the user says they're done (or stops adding info), check the merged profile. If any REQUIRED fields are still empty (per the lists above), DON'T submit. Your spoken final turn names them: "Got most of it. I still need address area and max guests before I can create the listing." Ask for the most important one next or tell them they can switch to the form to complete the list. Owning the handoff is what makes you an agent, not a chatbot.

# When the user goes vague

Offer concrete examples / sensible defaults instead of repeating questions. "Like 5km radius, or all of Hyderabad? Doesn't have to be exact." If they say "whatever you decide", apply a reasonable default via extract_fields and move on.

# Final reply format

After tool calls, your spoken reply just talks naturally — no JSON output here, you're on voice. The transcripts go straight to the chat panel.`;

/**
 * Build a scope-context block the onboarding agent gets appended to its
 * system instruction. The block tells the agent which portal the user
 * walked through, what categories are in-scope, and HOW to gracefully
 * redirect when the user describes something out of scope.
 *
 * Why it's worded as guidance rather than rules: a real agent reads
 * context and reasons. Hard "you must refuse X" rules break when users
 * say something halfway in-scope (a homestay-owner who also does private
 * tours, etc.). Letting the agent reason gives nuance.
 */
function buildOnboardingScopeBlock(entry: OnboardingEntry): string {
  if (entry === 'transport') {
    return `# Entry scope — transport portal

The user walked in through the Transport Dashboard's "Register Vehicle" door. They are publishing a TRANSPORT listing. ALWAYS set \`category\` to "driver-cab" (or "driver-auto" for an auto rickshaw operator) — it's required for the client's listing-kind dispatch even when per-vehicle detail lives in \`transportationTypes[]\`. Also pick a transportMode (hourly | day | package). Lead with "What kind of vehicle or driver service do you run?" (or in their language). Don't ask about home services or stays. Drivers may run multiple vehicles — capture each in transportationTypes[].

Required for transport: category ("driver-cab" or "driver-auto" — always required), name, location, languages, experience, serviceRadius, transportMode, the matching rate (pricePerHour for hourly, pricePerDay for day, packageOptions for package), and a priced transportationTypes array with all catalog-required fields filled per entry. vehicleYear and vehicleClass are NOT required.

If their description is a service ("I'm a plumber"), offer redirect to provider portal. If it's a stay, offer redirect to host portal.`;
  }
  if (entry === 'host') {
    return `# Entry scope — host portal

The user walked in through the Host Dashboard's "Add Property" door. They almost certainly want to publish a stay listing (hotel, homestay, lodge, village-stay, farm-stay, heritage). Frame your first turn around stays — "kaisi property list karni hai, hotel ya homestay?" or in their language equivalent. Don't ask "are you a host or service provider?" — they already answered by being here.

If their description is genuinely a service or transport listing ("I'm a plumber", "I drive an auto"), don't refuse and don't try to wedge it into a stay. Acknowledge warmly, explain they're in the host portal, and offer to take them to the right place — call navigate_to_page (if available) or just say: "Lagta hai aap services list karna chahte ho — wo Provider Dashboard se add karna hoga, main aapko le jaaun?". Then stop and wait.

For ambiguous cases (someone offering a homestay AND tours), confirm which they want to publish FIRST — the second listing can be added later.`;
  }
  if (entry === 'service') {
    return `# Entry scope — provider portal

The user walked in through the Provider Dashboard's "Add Listing" door. They almost certainly want to publish a service or transport listing — cleaning, plumber, electrician, cook, carpenter, mechanic, tour-guide, photographer, helper, freelancer, driver-cab, driver-auto. Frame your first turn around services — "kaunsi service offer karte ho?" or equivalent. Don't ask "are you a host?" — they already chose by being here.

If their description is genuinely a stay listing ("I run a homestay"), don't refuse. Acknowledge, explain they're in the provider portal, and offer to take them to Host Dashboard: "Property list karni hai? Wo host portal se hota hai, main aapko bhej deta hoon?". Then stop and wait.

For ambiguous cases (someone who's a tour-guide AND has rooms to rent), confirm which listing they want to publish FIRST.`;
  }
  return `# Entry scope — open

No portal preset. Detect category from the user's first message and proceed.`;
}

// Voice-only tool: lets the model navigate the SPA. Doesn't fit the
// shared agent tool registry (which is for data tools); voice exposes
// it directly as a function declaration. Server intercepts this call
// and forwards to the client as a `ui_action` event so the React
// router can handle it.
const NAVIGATE_TOOL_NAME = 'navigate_to_page';
const NAVIGATE_TOOL_DECLARATION = {
  name: NAVIGATE_TOOL_NAME,
  description:
    "Navigate the user to a specific app page. Use when the user says 'open stays' / 'go to my bookings' / 'show me services' / 'take me to dashboard'. Args: {path: '/explore' | '/services' | '/transport' | '/bookings' | '/wishlist' | '/dashboard/host' | '/messages' | '/become-host', filters?: {location?, query?, category?}}",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "App path to navigate to (e.g. '/explore', '/services').",
      },
      filters: {
        type: 'object',
        description: 'Optional URL query filters (location, query, category).',
        properties: {
          location: { type: 'string' },
          query: { type: 'string' },
          category: { type: 'string' },
        },
      },
    },
    required: ['path'],
  },
};

// Booking handoff. Voice agent CAN'T commit a booking (no slot holds, no
// payment orders — that's the user's tap). What it CAN do is open the
// listing's booking modal so the user can pick dates and tap Confirm &
// Pay themselves. This is the voice analogue of the text agent's
// `start_booking` action: same UX outcome, different transport.
const START_BOOKING_TOOL_NAME = 'start_booking';
const START_BOOKING_TOOL_DECLARATION = {
  name: START_BOOKING_TOOL_NAME,
  description:
    "Open the booking modal for a specific listing so the user can confirm dates and pay themselves. Call this whenever the user says 'book it' / 'yes go ahead' / 'confirm' / 'haan kar do' on a listing already in the conversation. You MUST have a real listingId from a previous search_listings result — never invent one. Args: {listingId: string}. The UI navigates to the listing page with the booking modal pre-opened.",
  parameters: {
    type: 'object',
    properties: {
      listingId: {
        type: 'string',
        description: 'Real listingId from a previous search_listings / get_listing_details result.',
      },
    },
    required: ['listingId'],
  },
};

let sharedClient: GoogleGenAI | null = null;

/**
 * Lazy-init the Vertex AI client. The SA JSON lives in config.llm.vertexServiceAccountJson
 * (populated from Secrets Manager env var GEMINI_VERTEX_SA_JSON). Parsed once; the auth
 * library caches OAuth tokens internally.
 */
function getClient(): GoogleGenAI {
  if (sharedClient) return sharedClient;

  const saJson = config.llm.vertexServiceAccountJson;
  const project = config.llm.vertexProject;
  const location = config.llm.vertexLocation;

  if (!saJson || !project || !location) {
    throw new Error('Vertex Live API not configured: missing GEMINI_VERTEX_SA_JSON / _PROJECT / _LOCATION');
  }

  const credentials = JSON.parse(saJson);

  sharedClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    googleAuthOptions: { credentials },
  });
  return sharedClient;
}

/** Two voice modes share the Live infrastructure but expose different
 *  tools, prompts, and event shapes:
 *
 *  - 'sathi'      → the in-app assistant (search listings, navigate, etc.)
 *  - 'onboarding' → the provider onboarding agent (extract_fields,
 *                   set_picker_action, submit_listing). Profile state
 *                   syncs to the client via 'profile_update' events. */
export type VoiceMode = 'sathi' | 'onboarding';

/** Onboarding entry scope.
 *
 *  - 'host'    → user came from Host Dashboard's Add Property → only stay
 *                listings are valid here. If they describe a service, the
 *                agent acknowledges and offers to switch portals.
 *  - 'service' → user came from Provider Dashboard → service or transport
 *                listings only. Same redirect dance for stay descriptions.
 *  - 'any'     → no preset (default) → agent freely detects category.
 *
 *  This is scope, not a hard wall. The agent stays sentient — it just gets
 *  told the doorway the user walked through. */
export type OnboardingEntry = 'host' | 'service' | 'transport' | 'any';

export interface VoiceSessionParams {
  clientWs: WebSocket;
  userId: string;
  displayName?: string;
  mode?: VoiceMode;
  /** Only meaningful when mode='onboarding'. Defaults to 'any'. */
  entryType?: OnboardingEntry;
  /** Onboarding-only seed profile from the client. Lets the voice agent see
   *  what's already filled in the form before the first turn so it doesn't
   *  re-ask those fields. Updated mid-session via `profile_sync` messages. */
  initialProfile?: Record<string, unknown>;
}

/**
 * Start a single voice session. Returns when both sides have closed. Caller
 * is responsible for authenticating the client WS before handing it here.
 */
export async function runVoiceSession(params: VoiceSessionParams): Promise<void> {
  const { clientWs, userId, displayName, mode = 'sathi', entryType = 'any', initialProfile } = params;

  let upstream: Session | null = null;
  let closed = false;

  const sendToClient = (payload: Record<string, unknown>) => {
    if (clientWs.readyState === clientWs.OPEN) {
      try { clientWs.send(JSON.stringify(payload)); } catch { /* client gone */ }
    }
  };

  const closeAll = (reason?: string) => {
    if (closed) return;
    closed = true;
    try { upstream?.close(); } catch { /* already closed */ }
    try { clientWs.close(1000, reason ?? 'done'); } catch { /* already closed */ }
    logger.info('Voice session closed', { userId, reason });
  };

  try {
    const client = getClient();
    const basePrompt = mode === 'onboarding' ? ONBOARDING_INSTRUCTION : SYSTEM_INSTRUCTION;
    // Entry scope is appended as a context block (not a hard rule) so the
    // agent can read it like a real signal and decide how to act — that's
    // the agent-vs-chatbot distinction. A chatbot would refuse out-of-scope
    // input; the agent acknowledges and redirects.
    const scopeBlock = mode === 'onboarding' ? buildOnboardingScopeBlock(entryType) : '';
    // Seed profile from the client so the voice agent doesn't re-ask
    // fields the user already filled on the manual form or in a prior
    // text-agent turn. The block is appended as context, not as a rule.
    const seededProfile: OnboardingProfileState = mode === 'onboarding' && initialProfile
      ? ({ ...(initialProfile as OnboardingProfileState) })
      : ({} as OnboardingProfileState);
    const profileBlock = mode === 'onboarding'
      ? `# What we know so far (do NOT re-ask filled fields)\n${JSON.stringify(seededProfile, null, 2)}`
      : '';
    const systemInstruction = [
      basePrompt,
      scopeBlock,
      profileBlock,
      `You're speaking with ${displayName || 'a user'}.`,
    ].filter(Boolean).join('\n\n');

    // Tool surface depends on mode. Sathi gets the read-only data tools
    // + navigate. Onboarding gets extract_fields + set_picker_action +
    // submit_listing. Per-mode registries kept separate so the model
    // can't accidentally call the wrong tool.
    const voiceFunctionDeclarations = mode === 'onboarding'
      ? [
          ...ONBOARDING_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parametersJsonSchema as Record<string, unknown>,
          })),
          // Onboarding gets navigate too — for the cross-portal redirect
          // case (host portal user who turns out to be a service provider).
          // The handler below routes navigate_to_page identically in both
          // modes; only the prompt tells the model when to use it.
          NAVIGATE_TOOL_DECLARATION,
        ]
      : [
          ...READ_ONLY_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parametersJsonSchema as Record<string, unknown>,
          })),
          // prepare_booking is the booking-intent tool. Voice executes it
          // through the shared agent registry (same code path as text),
          // and the success payload is pushed to the client as a
          // `show_booking_card` ui_action so the inline Confirm & Pay
          // card renders in the chat panel — same UX as text-chat. No
          // navigation involved; the user's tap on the card is the final
          // payment action.
          {
            name: 'prepare_booking',
            description: TOOLS_BY_NAME.prepare_booking?.description ?? 'Lock a slot + create a Razorpay order; renders an inline Confirm & Pay card.',
            parameters: TOOLS_BY_NAME.prepare_booking?.parametersJsonSchema as Record<string, unknown>,
          },
          NAVIGATE_TOOL_DECLARATION,
          // start_booking remains as the FALLBACK for browsing intent
          // ("show me the Trident page") — navigates to the listing
          // detail page without locking anything. For actual "book it"
          // intent the agent uses prepare_booking above.
          START_BOOKING_TOOL_DECLARATION,
        ];

    // Per-session AgentTurnContext used when executing tools from voice.
    // No real abort signal (the Live session is long-running) and no
    // realtime emit for now — the chip stream for voice goes through
    // sendToClient directly below.
    //
    // Onboarding mode adds the mutable profile state + picker action
    // tracking that the onboarding tools mutate in place.
    const voiceCtx: AgentTurnContext | OnboardingAgentContext = mode === 'onboarding'
      ? {
          userId,
          displayLang: 'en',
          requestId: randomUUID(),
          abortSignal: new AbortController().signal,
          toolResultCache: new Map(),
          // Start from the client-supplied profile (or {} if absent) so
          // extract_fields merges INTO existing fields rather than reset.
          profile: seededProfile,
          pickerAction: 'none' as OnboardingPickerAction,
        }
      : {
          userId,
          displayLang: 'en',
          requestId: randomUUID(),
          abortSignal: new AbortController().signal,
          toolResultCache: new Map(),
        };

    // Per-turn input-transcript quality tally. Vertex streams the user's
    // transcription in chunks; we count how many we forwarded vs dropped as
    // garbage so that, at turnComplete, we can distinguish a WHOLE-utterance
    // misfire (the user clearly spoke but every chunk was unintelligible)
    // from a clean turn — and ask them to repeat instead of silently
    // swallowing their words. Reset on every turnComplete.
    let turnGoodChunks = 0;
    let turnGarbageChunks = 0;
    // Models that emit BOTH modelTurn text parts AND outputAudioTranscription
    // would deliver every reply twice (the client renders both as the same
    // assistant_transcript stream). Once transcription has been seen, it is
    // the canonical source — stop forwarding text parts for the session.
    let sawOutputTranscript = false;

    upstream = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // Enable transcription on both sides so we can stream text to
        // the chat panel alongside the audio. Without these flags Vertex
        // only emits audio chunks, never text — chat would stay empty
        // during a voice exchange.
        // The two `{}` configs use defaults; we don't need to tune
        // language hints here — auto-detect is what we want.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Tools available to the voice agent. The model will emit
        // `toolCall` messages we handle below; Vertex pauses the audio
        // turn until we send back a `toolResponse`.
        tools: [{ functionDeclarations: voiceFunctionDeclarations as never[] }],
      },
      callbacks: {
        onopen: () => {
          logger.info('Voice upstream opened', { userId });
          sendToClient({ type: 'ready' });
        },
        onmessage: (msg: LiveServerMessage) => {
          // Forward audio chunks the model emits. They arrive as inline data
          // on model_turn parts — base64 PCM at 24kHz.
          const parts = msg.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            const inline = part.inlineData;
            if (inline?.data && inline.mimeType?.startsWith('audio/')) {
              sendToClient({ type: 'audio', data: inline.data, mimeType: inline.mimeType });
            }
            // Some preview models emit text alongside audio in modelTurn
            // parts. We forward as the same `assistant_transcript` event
            // shape used for outputAudioTranscription below so the client
            // doesn't need two code paths — but ONLY while transcription
            // hasn't shown up, so a model emitting both doesn't double
            // every reply in the chat panel.
            if (part.text && !sawOutputTranscript) {
              sendToClient({ type: 'assistant_transcript', text: part.text });
            }
          }
          // User-side transcription — what Vertex thinks the user just said.
          // Comes in as serverContent.inputTranscription.text (incremental
          // chunks; we forward each chunk and the client appends).
          //
          // Vertex's input STT auto-detects language per utterance and
          // sometimes hallucinates Italian/Chinese/etc. when audio is
          // unclear or silent. Drop chunks that look like confused
          // mid-language guesses to keep the chat readable.
          const inputT = (msg.serverContent as { inputTranscription?: { text?: string } })?.inputTranscription;
          if (inputT?.text) {
            if (looksLikeTranscriptGarbage(inputT.text)) {
              turnGarbageChunks++;
            } else {
              turnGoodChunks++;
              sendToClient({ type: 'user_transcript', text: inputT.text });
            }
          }
          // Model-side transcription — what Sathi just said.
          const outputT = (msg.serverContent as { outputTranscription?: { text?: string } })?.outputTranscription;
          if (outputT?.text) {
            sawOutputTranscript = true;
            sendToClient({ type: 'assistant_transcript', text: outputT.text });
          }
          if (msg.serverContent?.turnComplete) {
            // Whole-utterance garbage: we received input-transcription chunks
            // (so the user did speak) but EVERY one was unintelligible. Tell
            // the client to ask for a repeat rather than letting the turn
            // look like the assistant ignored them.
            if (turnGoodChunks === 0 && turnGarbageChunks > 0) {
              sendToClient({ type: 'needs_repeat' });
            }
            turnGoodChunks = 0;
            turnGarbageChunks = 0;
            sendToClient({ type: 'turn_complete' });
          }
          if (msg.serverContent?.interrupted) {
            sendToClient({ type: 'interrupted' });
          }
          // Tool-calling: model wants to call one or more functions.
          // Execute each one, ship the results back via sendToolResponse,
          // and stream chip events to the client UI.
          if (msg.toolCall?.functionCalls && msg.toolCall.functionCalls.length > 0) {
            void handleVoiceToolCalls(
              msg.toolCall.functionCalls,
              upstream!,
              voiceCtx,
              sendToClient,
              mode,
            );
          }
        },
        onerror: (err: ErrorEvent) => {
          logger.error('Voice upstream error', { userId, message: err.message });
          sendToClient({ type: 'error', message: err.message || 'upstream error' });
          closeAll('upstream_error');
        },
        onclose: (evt: CloseEvent) => {
          logger.info('Voice upstream closed', { userId, code: evt.code, reason: evt.reason });
          // 1008 = "policy violation" — Vertex Live's main reason here is
          // the publisher model isn't allow-listed for this GCP project.
          // Without an explicit error message the client lands back on
          // "idle" and looks like a transient issue, inviting endless
          // retries. Surface the real cause so the user stops clicking
          // Start. Other close codes (1000 normal, 1006 abnormal) skip
          // this so we don't lie about transient drops.
          if (evt.code === 1008) {
            const friendly = /Publisher Model.*was not/i.test(evt.reason || '')
              ? `Voice unavailable: the Live API model isn't enabled on this GCP project. Set GEMINI_LIVE_MODEL to a model your project can access, or request Live API access for ${MODEL}.`
              : `Voice unavailable: ${evt.reason || 'upstream rejected the session'}`;
            sendToClient({ type: 'error', message: friendly });
          }
          closeAll('upstream_closed');
        },
      },
    });

    clientWs.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!upstream) return;

      if (msg.type === 'audio' && typeof msg.data === 'string') {
        // Client sends 16kHz 16-bit PCM, base64-encoded. Vertex expects the
        // same as "audio/pcm;rate=16000" inline data.
        upstream.sendRealtimeInput({
          audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
        });
      } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // Mixed-mode input: the chat panel lets users type while the Live
        // voice session is open. Route that typed turn into the SAME Live
        // session instead of the separate text assistant so voice and text
        // share booking/onboarding state.
        upstream.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: msg.text.trim() }] }],
          turnComplete: true,
        });
      } else if (msg.type === 'interrupt') {
        // Phase 3: client-side VAD detected the user speaking over the
        // model. Vertex Live's own VAD will catch up via the audio
        // stream we keep forwarding, so this is mostly a telemetry
        // signal — but we ack with `interrupted` so the client's
        // server-side fallback path stays consistent (clears any
        // chunks that snuck through between local detection and the
        // upstream's own interrupt event).
        sendToClient({ type: 'interrupted' });
        logger.debug('Voice client-side barge-in', { userId });
      } else if (msg.type === 'profile_sync' && mode === 'onboarding' && msg.profile && typeof msg.profile === 'object') {
        // Mid-session sync from the client (manual form edits, AI-text
        // turn, etc.). Merge into the voice agent's profile state so
        // subsequent turns see the latest fields and don't re-ask.
        const onboardCtx = voiceCtx as OnboardingAgentContext;
        Object.assign(onboardCtx.profile, msg.profile as OnboardingProfileState);
        logger.debug('Voice profile_sync applied', { userId, keys: Object.keys(msg.profile) });
      } else if (msg.type === 'end') {
        closeAll('client_ended');
      }
    });

    clientWs.on('close', () => closeAll('client_closed'));
    clientWs.on('error', () => closeAll('client_errored'));

    // Safety cap — tear down any session older than 10 minutes to protect
    // runaway cost / leaked sessions. Voice UX shouldn't need longer than
    // this per continuous turn-taking; client can reconnect.
    const idleTimer = setTimeout(() => closeAll('idle_timeout'), 10 * 60 * 1000);
    idleTimer.unref();
    clientWs.once('close', () => clearTimeout(idleTimer));
  } catch (err: any) {
    logger.error('Voice session setup failed', { userId, error: err?.message });
    sendToClient({ type: 'error', message: err?.message || 'setup_failed' });
    closeAll('setup_failed');
    throw err;
  }
}

/**
 * Execute a batch of function calls Vertex Live emitted, send the
 * results back to the upstream session, and stream chip + UI-action
 * events to the client. The model pauses its audio reply until we
 * finish — we want to be quick.
 *
 * Two categories of calls:
 *   - data tools (search_listings, get_listing_details, etc.) live in
 *     the existing TOOLS_BY_NAME registry — execute and return data.
 *   - navigate_to_page is voice-only — server intercepts, forwards as
 *     a `ui_action` event to the client, and tells the model "ok, the
 *     page is opening". No real data to return.
 */
async function handleVoiceToolCalls(
  calls: FunctionCall[],
  upstream: Session,
  ctx: AgentTurnContext | OnboardingAgentContext,
  sendToClient: (payload: Record<string, unknown>) => void,
  mode: VoiceMode,
): Promise<void> {
  const responses: Array<{ id?: string; name: string; response: Record<string, unknown> }> = [];
  // Pick the right tool registry based on mode. Sathi mode also has
  // the navigate tool which lives outside any registry — handled
  // specially below.
  const registry = mode === 'onboarding' ? ONBOARDING_TOOLS_BY_NAME : TOOLS_BY_NAME;

  for (const call of calls) {
    const name = call.name ?? '';
    const args = (call.args ?? {}) as Record<string, unknown>;
    const callId = call.id;
    const start = Date.now();

    // Surface a "tool starting" chip immediately so the user sees
    // motion while the actual call runs. Same shape the Phase 5
    // chip-emitter sends for the text agent.
    sendToClient({
      type: 'tool_start',
      name,
      argsSummary: summariseArgsForChip(name, args),
      ts: Date.now(),
    });

    try {
      // Voice-only navigation tool (both modes) — forward to client.
      // In onboarding mode, the agent uses this for the cross-portal
      // redirect case (host portal → service provider, etc.).
      if (name === NAVIGATE_TOOL_NAME) {
        sendToClient({ type: 'ui_action', action: 'navigate', params: args });
        const summary = `Opening ${typeof args.path === 'string' ? args.path : 'page'}`;
        responses.push({
          id: callId,
          name,
          response: { ok: true, message: summary },
        });
        sendToClient({ type: 'tool_done', name, durationMs: Date.now() - start, summary, ts: Date.now() });
        continue;
      }

      // Voice booking handoff (Sathi mode only). Forward to client as a
      // ui_action so the React router opens the listing's booking modal.
      // No data lookup needed here — the user-visible result is the modal
      // popping up. We respond OK back to the model so it can speak a
      // natural confirmation ("Opening Trident Hyderabad — pick your
      // dates and tap Confirm & Pay there.")
      if (name === START_BOOKING_TOOL_NAME) {
        sendToClient({ type: 'ui_action', action: 'start_booking', params: args });
        const summary = `Opening booking for listing ${typeof args.listingId === 'string' ? args.listingId.slice(0, 8) : ''}`;
        responses.push({
          id: callId,
          name,
          response: { ok: true, message: summary },
        });
        sendToClient({ type: 'tool_done', name, durationMs: Date.now() - start, summary, ts: Date.now() });
        continue;
      }

      // Data tools — execute via the right registry for this mode.
      const def = registry[name] as ToolDefinition | undefined;
      if (!def) {
        responses.push({
          id: callId,
          name,
          response: { ok: false, error: `Unknown tool: ${name}` },
        });
        sendToClient({ type: 'tool_error', name, message: 'unknown tool', ts: Date.now() });
        continue;
      }

      // Validate args against the tool's zod schema; same as agent-loop.
      const parsed = def.argsSchema.safeParse(args);
      if (!parsed.success) {
        responses.push({
          id: callId,
          name,
          response: {
            ok: false,
            error: `Invalid args: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          },
        });
        sendToClient({ type: 'tool_error', name, message: 'invalid args', ts: Date.now() });
        continue;
      }

      const data = await def.execute(parsed.data as never, ctx);
      const durationMs = Date.now() - start;
      const summary = def.summarize(parsed.data as never, data as never);

      // prepare_booking is special: on success we push the full payload to
      // the client as a `show_booking_card` ui_action so the React widget
      // can render the inline Confirm & Pay card right in the chat panel.
      // The model still gets the tool result so it can speak naturally
      // ("Locked Trident Hyderabad for 12–13 May — tap below to pay.").
      // On failure we push nothing UI-side — the model relays the
      // userMessage in speech.
      if (mode === 'sathi' && name === 'prepare_booking') {
        const result = data as { success?: boolean } | undefined;
        if (result?.success) {
          sendToClient({ type: 'ui_action', action: 'show_booking_card', params: data as Record<string, unknown> });
        }
      }

      // Onboarding tools mutate ctx in place — forward those mutations
      // to the client so the side panel / form fills in real-time as
      // the agent extracts. Without this the voice flow would extract
      // 6 fields and the UI would still look empty until the next
      // page load.
      if (mode === 'onboarding') {
        const onboardCtx = ctx as OnboardingAgentContext;
        if (name === 'extract_fields') {
          // Forward the merged profile so client overwrites local
          // state with whatever the agent has accumulated. Sending
          // `applied` from the result would also work; sending the
          // full merged state is more idempotent.
          sendToClient({
            type: 'profile_update',
            profile: { ...onboardCtx.profile },
            ts: Date.now(),
          });
        } else if (name === 'set_picker_action') {
          sendToClient({
            type: 'picker_action',
            action: onboardCtx.pickerAction,
            ts: Date.now(),
          });
        } else if (name === 'submit_listing') {
          sendToClient({
            type: 'submit_ready',
            profile: { ...onboardCtx.profile },
            ts: Date.now(),
          });
        }
      }

      responses.push({
        id: callId,
        name,
        response: { ok: true, data: data as Record<string, unknown> },
      });
      sendToClient({ type: 'tool_done', name, durationMs, summary, ts: Date.now() });
    } catch (err) {
      const message = (err as Error).message ?? 'Tool execution failed';
      logger.warn('voice tool execution failed', { tool: name, error: message });
      responses.push({
        id: callId,
        name,
        response: { ok: false, error: message },
      });
      sendToClient({ type: 'tool_error', name, message, ts: Date.now() });
    }
  }

  // Ship all responses in one batch. The Live SDK expects an array
  // matching the input call IDs; the model resumes audio after.
  try {
    upstream.sendToolResponse({ functionResponses: responses });
  } catch (err) {
    logger.warn('voice sendToolResponse failed', { error: (err as Error).message });
  }
}

/**
 * Heuristic filter for low-confidence STT output. Vertex's input
 * transcription auto-detects language per utterance; on silence /
 * background noise / brief utterances it sometimes returns confident
 * fragments in unrelated scripts (Italian "Un lusso starò", Chinese
 * "嗯，一个人啊"). These are clearly wrong when the user is speaking
 * English or an Indian language — drop them rather than poisoning
 * the chat.
 *
 * Keep this conservative: false-drops (silently losing a real
 * transcript) are worse than false-keeps (showing one weird line).
 */
function looksLikeTranscriptGarbage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;

  // Brace-prefixed gibberish like "{}嗯，..." we've seen in real logs —
  // looks like a serialization artifact, never useful.
  if (/^[{}[\]()]+/.test(trimmed)) return true;

  // CJK characters — our user base is Indian-language speakers; East
  // Asian script is always a Vertex misfire. Gate behind env var if
  // deployment ever spans East Asia.
  if (/[぀-ヿ㐀-䶿一-鿿가-힯]/.test(trimmed)) return true;

  // Italian / Spanish / Romance-language romanized fragments are
  // Vertex's "I don't know what language this is" fallback. Detect a
  // few signature words that almost never appear in normal English/
  // Hindi/Indian-language speech.
  if (/\b(lusso|starò|allora|grazie|signor|señor|hola|por\s+favor|buenos\s+días)\b/i.test(trimmed)) return true;

  // Random ASCII salad — single uppercase letters separated by spaces,
  // or 3+ consecutive non-word punctuation, look like noise the STT
  // tried to make sense of.
  if (/^[A-Z](\s[A-Z]){2,}$/.test(trimmed)) return true;

  // Mixed-script spaghetti — Devanagari + Latin + something else in
  // one short utterance is almost always Vertex confused. Counts the
  // distinct scripts; >2 scripts in <40 chars is suspicious.
  const scripts: Array<RegExp> = [
    /[a-zA-Z]/,                       // Latin
    /[ऀ-ॿ]/,                // Devanagari (Hindi/Marathi)
    /[ఀ-౿]/,                // Telugu
    /[஀-௿]/,                // Tamil
    /[ಀ-೿]/,                // Kannada
    /[ഀ-ൿ]/,                // Malayalam
    /[ঀ-৿]/,                // Bengali
    /[਀-੿]/,                // Gurmukhi (Punjabi)
    /[઀-૿]/,                // Gujarati
    /[଀-୿]/,                // Odia
  ];
  const distinctScripts = scripts.filter((re) => re.test(trimmed)).length;
  if (distinctScripts >= 3 && trimmed.length < 60) return true;

  // Devanagari heuristics — Vertex frequently misfires English/regional
  // language audio as Devanagari blobs. Two distinct failure modes:
  //   (a) Short noise: "महमद", "जे" — 1-3 tokens, no real Hindi grammar.
  //       Almost always misheard background or a name fragment Vertex
  //       guessed at. Real Hindi turns this short would be common openers
  //       ("हाँ", "ठीक", "नमस्ते", "हाँ जी") — we allow those by checklist.
  //   (b) Long noise: 4+ Devanagari words with zero Hindi function words.
  //       Usually Vertex transliterated Telugu/Tamil audio into Devanagari,
  //       producing a phonetic blob that LOOKS like Hindi but isn't.
  const devanagari = trimmed.match(/[ऀ-ॿ]+/g);
  if (devanagari && devanagari.length > 0) {
    const devText = devanagari.join(' ');
    const wordCount = devText.split(/\s+/).filter((w) => w.length > 0).length;

    // Whitelist of legitimate short Hindi openers / acknowledgments.
    // Anything in this set is real conversational Hindi and passes.
    const SHORT_HINDI_OK = new Set([
      'हाँ', 'हां', 'हा', 'जी', 'नहीं', 'नही', 'ना', 'ठीक', 'अच्छा', 'अच्छ',
      'नमस्ते', 'नमस्कार', 'धन्यवाद', 'शुक्रिया', 'सलाम', 'अलविदा',
      'क्या', 'कौन', 'कब', 'कहाँ', 'कैसे', 'क्यों',
      'ओके', 'ओके', 'सर', 'मैम', 'भैया', 'दीदी',
    ]);

    if (wordCount <= 3) {
      // Short blob — only pass if at least one token is in the whitelist
      // OR contains a Hindi function word. Otherwise drop as likely noise.
      const tokens = devText.split(/\s+/).filter(Boolean);
      const looksConversational = tokens.some((t) => SHORT_HINDI_OK.has(t));
      const hasFunctionWord = /\b(है|हैं|था|थे|थी|हो|हूं|हूँ|का|की|के|को|में|से|और|या|पर|तो|भी|यह|वह|ये|वे|मैं|आप|हम)\b/.test(devText);
      if (!looksConversational && !hasFunctionWord) return true;
    } else {
      // Long blob — needs at least one function word, otherwise it's
      // probably transliterated regional-language noise.
      const HINDI_FUNCTION_WORDS = /\b(है|हैं|था|थे|थी|हो|हूं|हूँ|का|की|के|को|में|से|और|या|पर|तो|भी|यह|वह|ये|वे|मैं|तू|तुम|आप|हम|कौन|कब|क्या|क्यों|कहाँ|कैसे|जो|जिस|नहीं|नही|बहुत|बस|कुछ|सब|एक|दो|तीन)\b/;
      if (!HINDI_FUNCTION_WORDS.test(devText)) return true;
    }
  }

  // Very short Latin-only fragments (1-2 chars, like "je", "ah") are
  // almost always Vertex catching the trailing breath of an utterance,
  // not real content. Real short Latin user replies ("yes", "no", "ok",
  // "hi") are 2+ chars AND in a small whitelist. Anything else short is
  // noise. (Length < 2 was already caught above.)
  const isLatin = /^[a-zA-Z'\s-]+$/.test(trimmed);
  if (isLatin) {
    const tokenCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (tokenCount === 1 && trimmed.length <= 3) {
      const SHORT_LATIN_OK = new Set([
        'yes', 'no', 'ok', 'okay', 'hi', 'hey', 'sup', 'yo', 'yep', 'nah', 'yup',
      ]);
      if (!SHORT_LATIN_OK.has(trimmed.toLowerCase())) return true;
    }
  }

  return false;
}

function summariseArgsForChip(name: string, args: Record<string, unknown>): string {
  if (name === 'navigate_to_page' && typeof args.path === 'string') return args.path;
  if (name === 'start_booking' && typeof args.listingId === 'string') return `book ${args.listingId.slice(0, 8)}`;
  if (name === 'search_listings') {
    const parts: string[] = [];
    if (typeof args.category === 'string') parts.push(args.category);
    if (typeof args.location === 'string') parts.push(`in ${args.location}`);
    return parts.join(' ') || 'listings';
  }
  if (typeof args.bookingId === 'string') return args.bookingId.slice(0, 8);
  if (typeof args.listingId === 'string') return args.listingId.slice(0, 8);
  return '';
}
