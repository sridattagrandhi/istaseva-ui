#!/usr/bin/env node
/**
 * Live-model smoke test for the chat assistant (Path A of the certification
 * plan — see docs/ASSISTANT_STAGING_CERTIFICATION.md).
 *
 * The replay/unit suites STUB the model, so they cannot catch a prompt
 * regression where live Gemini stops emitting the right tool calls. This
 * harness fires real prompts at a deployed `/api/assistant` and asserts on the
 * returned JSON envelope ({ message, action, suggestions, toolCalls, requestId })
 * — specifically the `toolCalls[]` array, each entry exposing { name, args, ok,
 * result }.
 *
 * Auth: `/api/assistant` is Firebase-gated with no dev bypass, so a real ID
 * token is required. Pass it via env — it never touches this file or the repo:
 *
 *   SMOKE_TOKEN='<firebase id token>' \
 *   SMOKE_BASE_URL='https://d2ypux27ikks41.cloudfront.net' \
 *   node scripts/assistant-smoke.mjs
 *
 * Get a token from a signed-in staging session: DevTools console →
 *   await firebase.auth().currentUser.getIdToken()
 * (or your app's equivalent). Tokens expire in ~1h.
 *
 * Self-test (no token, no network) — proves the assertion logic classifies
 * good vs. regressed responses correctly:
 *
 *   node scripts/assistant-smoke.mjs --self-test
 *
 * Exit codes: 0 = all pass, 1 = one or more assertions failed, 2 = config /
 * transport / auth error (nothing was actually asserted).
 *
 * Scope: read-only scenarios only (search, availability-mode, hallucination
 * guard, language). Pricing-parity and prepare-booking are side-effectful
 * (holds + Razorpay orders) and stay in the manual runbook.
 */

import crypto from 'node:crypto';

const DEFAULT_BASE = 'https://d2ypux27ikks41.cloudfront.net';

// ── pure assertion helpers (unit-testable, no I/O) ──────────────────────────
const toolCalls = (res) => (Array.isArray(res?.toolCalls) ? res.toolCalls : []);
const calledTool = (res, name) => toolCalls(res).find((t) => t?.name === name);
const okTool = (res, name) => toolCalls(res).some((t) => t?.name === name && t?.ok === true);
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
const DEVANAGARI = /[ऀ-ॿ]/;
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const pass = (detail) => ({ pass: true, detail });
const fail = (detail) => ({ pass: false, detail });

// ── scenario battery ────────────────────────────────────────────────────────
// Each scenario carries an `assert(res)` and self-test `fixtures` (a response
// that MUST pass and one that MUST fail), so the logic is provable offline.
const SCENARIOS = [
  {
    id: 'S1-search-stay',
    title: 'Discovery search runs a real search_listings call',
    body: {
      messages: [{ role: 'user', content: 'Show me homestays in Hyderabad' }],
      displayLang: 'en',
      context: { surface: 'discovery', platform: 'web' },
    },
    assert(res) {
      if (!toolCalls(res).length) return fail('no toolCalls — tool loop may have fallen back to legacy path');
      return okTool(res, 'search_listings')
        ? pass('search_listings called and ok')
        : fail(`expected a search_listings call, saw: [${toolCalls(res).map((t) => t.name).join(', ') || 'none'}]`);
    },
    fixtures: {
      pass: { message: 'Here are a few homestays in Hyderabad.', action: { type: 'none', params: {} }, toolCalls: [{ name: 'search_listings', args: { category: 'stay', location: 'Hyderabad' }, ok: true, result: { ok: true, data: { hits: [{ id: 'x' }] } } }] },
      fail: { message: 'Which city are you looking in?', action: { type: 'none', params: {} }, toolCalls: [] },
    },
  },
  {
    id: 'S2-transport-hourly',
    title: 'Hourly driver + date → single search with hourly mode AND date (2026-06-12 regression)',
    body: {
      messages: [{ role: 'user', content: 'I need a driver in Hyderabad from 2 to 5pm on the 15th' }],
      displayLang: 'en',
      context: { surface: 'discovery', listingType: 'transport', platform: 'web' },
    },
    assert(res) {
      const call = calledTool(res, 'search_listings');
      if (!call) return fail(`no search_listings call — saw: [${toolCalls(res).map((t) => t.name).join(', ') || 'none'}]`);
      const a = call.args || {};
      const problems = [];
      if (a.transportPricingMode !== 'hourly') problems.push(`transportPricingMode=${JSON.stringify(a.transportPricingMode)} (want 'hourly')`);
      if (!nonEmpty(a.date)) problems.push('date missing (must resolve "the 15th")');
      return problems.length ? fail(problems.join('; ')) : pass(`hourly + date=${a.date}${a.startTime ? ` ${a.startTime}-${a.endTime}` : ''}`);
    },
    fixtures: {
      pass: { message: 'Checking hourly drivers for the 15th, 2–5pm.', action: { type: 'none', params: {} }, toolCalls: [{ name: 'search_listings', args: { category: 'transport', location: 'Hyderabad', transportPricingMode: 'hourly', date: '2026-06-15', startTime: '14:00', endTime: '17:00' }, ok: true, result: { ok: true, data: {} } }] },
      // Regression: re-asks the date / day-rate pitch, no hourly+date search.
      fail: { message: 'Which date did you want the driver?', action: { type: 'none', params: {} }, toolCalls: [{ name: 'search_listings', args: { category: 'transport', location: 'Hyderabad' }, ok: true, result: { ok: true, data: {} } }] },
    },
  },
  {
    id: 'S3-hallucination-guard',
    title: 'Invented listing id does not get fabricated or navigated to',
    body: {
      messages: [{ role: 'user', content: `Tell me all about listing ${FAKE_UUID}` }],
      displayLang: 'en',
      context: { surface: 'discovery', platform: 'web' },
    },
    assert(res) {
      // Fail if it navigated to the fake id...
      const act = res?.action;
      if (act?.type === 'open_listing' && act?.params?.listingId === FAKE_UUID) return fail('promoted open_listing to the fake id');
      // ...or if get_listing_details somehow returned ok:true for the fake id.
      const details = toolCalls(res).find((t) => t?.name === 'get_listing_details');
      if (details && details.ok === true && (details.args?.listingId === FAKE_UUID)) return fail('get_listing_details reported ok:true for a non-existent id');
      return pass('no fabrication / no navigation to the fake id');
    },
    fixtures: {
      pass: { message: "I couldn't find that listing — what are you after and where?", action: { type: 'none', params: {} }, toolCalls: [{ name: 'get_listing_details', args: { listingId: FAKE_UUID }, ok: false, result: { ok: false, data: { error: 'not_found', hint: 'use search_listings' } } }] },
      fail: { message: 'That listing is a lovely 3BHK in Goa for ₹4,000.', action: { type: 'open_listing', params: { listingId: FAKE_UUID, listingType: 'stay' } }, toolCalls: [] },
    },
  },
  {
    id: 'S4-language-hindi',
    title: 'Hindi prompt gets a Devanagari reply',
    body: {
      messages: [{ role: 'user', content: 'हैदराबाद में होमस्टे दिखाओ' }],
      displayLang: 'hi',
      context: { surface: 'discovery', platform: 'web' },
    },
    assert(res) {
      return DEVANAGARI.test(res?.message || '')
        ? pass('reply is in Devanagari')
        : fail(`reply not in Devanagari: ${JSON.stringify((res?.message || '').slice(0, 60))}`);
    },
    fixtures: {
      pass: { message: 'हैदराबाद में कुछ बढ़िया होमस्टे यहाँ हैं।', action: { type: 'none', params: {} }, toolCalls: [{ name: 'search_listings', args: {}, ok: true }] },
      fail: { message: 'Here are some homestays in Hyderabad.', action: { type: 'none', params: {} }, toolCalls: [{ name: 'search_listings', args: {}, ok: true }] },
    },
  },
];

// ── runners ──────────────────────────────────────────────────────────────────
function line() { console.log('─'.repeat(72)); }

function runSelfTest() {
  console.log('SELF-TEST — validating assertion logic against fixtures (no network)\n');
  let bad = 0;
  for (const s of SCENARIOS) {
    const good = s.assert(s.fixtures.pass);
    const regressed = s.assert(s.fixtures.fail);
    const okGood = good.pass === true;
    const okBad = regressed.pass === false;
    if (!okGood || !okBad) bad++;
    console.log(`${okGood && okBad ? '✅' : '❌'} ${s.id}`);
    if (!okGood) console.log(`    pass-fixture was NOT accepted: ${good.detail}`);
    if (!okBad) console.log(`    fail-fixture was NOT rejected: ${regressed.detail}`);
  }
  line();
  if (bad) { console.log(`SELF-TEST FAILED — ${bad}/${SCENARIOS.length} scenarios misclassify their fixtures`); return 1; }
  console.log(`SELF-TEST PASSED — all ${SCENARIOS.length} scenarios classify good vs. regressed correctly`);
  return 0;
}

async function postAssistant(base, token, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const r = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(timer); }
}

async function runLive() {
  const base = (process.env.SMOKE_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const token = process.env.SMOKE_TOKEN;
  if (!token) {
    console.error('CONFIG ERROR — SMOKE_TOKEN is not set. Provide a Firebase ID token from a signed-in staging session.');
    console.error('  SMOKE_TOKEN=<token> node scripts/assistant-smoke.mjs');
    return 2;
  }
  console.log(`LIVE SMOKE — ${base}/api/assistant\n`);

  // Preflight: confirm auth before running the (slow, costed) battery.
  const pre = await postAssistant(base, token, SCENARIOS[0].body).catch((e) => ({ error: e }));
  if (pre?.error) { console.error(`TRANSPORT ERROR — ${pre.error.message}`); return 2; }
  if (pre.status === 401 || pre.status === 403) {
    console.error(`AUTH FAILED (${pre.status}) — token invalid/expired or lacks access. ${pre.json?.error?.message || pre.json?.error || ''}`.trim());
    return 2;
  }
  if (pre.status >= 500) { console.error(`SERVER ERROR (${pre.status}) on preflight — ${pre.text?.slice(0, 200)}`); return 2; }

  let failed = 0;
  const rows = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    const t0 = Date.now();
    // Reuse the preflight response for S1 rather than paying for it twice.
    const resp = i === 0 ? pre : await postAssistant(base, token, s.body).catch((e) => ({ error: e }));
    const ms = Date.now() - t0;
    if (resp?.error) { failed++; rows.push({ s, verdict: fail(`transport error: ${resp.error.message}`), ms, tools: [] }); continue; }
    if (resp.status !== 200) { failed++; rows.push({ s, verdict: fail(`HTTP ${resp.status}: ${(resp.text || '').slice(0, 120)}`), ms, tools: [] }); continue; }
    const verdict = s.assert(resp.json);
    if (!verdict.pass) failed++;
    rows.push({ s, verdict, ms, tools: toolCalls(resp.json).map((t) => t.name), action: resp.json?.action?.type });
  }

  for (const r of rows) {
    console.log(`${r.verdict.pass ? '✅' : '❌'} ${r.s.id}  (${r.ms}ms)`);
    console.log(`    ${r.s.title}`);
    console.log(`    tools=[${r.tools.join(', ') || 'none'}] action=${r.action ?? '—'}`);
    console.log(`    → ${r.verdict.detail}`);
  }
  line();
  console.log(failed ? `LIVE SMOKE FAILED — ${failed}/${SCENARIOS.length} scenario(s) regressed` : `LIVE SMOKE PASSED — all ${SCENARIOS.length} scenarios green`);
  return failed ? 1 : 0;
}

const isSelfTest = process.argv.includes('--self-test');
const code = await (isSelfTest ? Promise.resolve(runSelfTest()) : runLive());
process.exit(code);
