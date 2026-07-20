import { test, expect, Page } from '@playwright/test';

/**
 * SEC-010 CSP audit — drives the flows that pull third-party origins and
 * collects Content-Security-Policy(-Report-Only) violations from a real
 * deployed environment (the CloudFront header policy is only in effect there).
 *
 * The frontend CSP currently ships REPORT-ONLY, so nothing is actually blocked
 * — this test surfaces what a future ENFORCING policy WOULD block, so the
 * allowlist can be completed before flipping the header. It also doubles as a
 * regression gate (a new third-party SDK that isn't allow-listed fails CI).
 *
 * Credentials come from env — never hardcode them here:
 *   CSP_TEST_EMAIL, CSP_TEST_PASSWORD
 * Optional heavy flows with side effects (creates a booking hold/order) are
 * gated behind CSP_TEST_PAYMENT=1.
 */

type Violation = { directive: string; blockedURI: string; sourceFile?: string };

const EMAIL = process.env.CSP_TEST_EMAIL;
const PASSWORD = process.env.CSP_TEST_PASSWORD;

// Accumulated across every flow in the run.
const all: Violation[] = [];

/** Group by "directive <- origin" so the summary is a clean gap list. */
function keyOf(v: Violation): string {
  let origin = v.blockedURI;
  try {
    origin = new URL(v.blockedURI).origin;
  } catch {
    // keyword sources like 'inline', 'eval', 'blob', 'data' — keep as-is
  }
  return `${v.directive}  <-  ${origin}`;
}

/**
 * Register a violation collector that runs at document-start on every
 * navigation and every (same-origin) frame, so LOAD-TIME violations (the app
 * bundle, fonts, inline styles) are captured too — a post-load listener would
 * miss them.
 */
async function installCollector(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp?: unknown[] };
    w.__csp = w.__csp || [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp!.push({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
      });
    });
  });
}

/** Pull + clear the violations collected since the last drain, and log them. */
async function drain(page: Page, label: string) {
  const found = (await page
    .evaluate(() => {
      const w = window as unknown as { __csp?: Violation[] };
      const v = w.__csp || [];
      w.__csp = [];
      return v;
    })
    .catch(() => [] as Violation[])) as Violation[];

  if (found.length) {
    console.log(`\n[CSP] ${found.length} violation(s) during: ${label}`);
    for (const v of found) console.log(`   ${v.directive}  <-  ${v.blockedURI}`);
  } else {
    console.log(`[CSP] clean: ${label}`);
  }
  all.push(...found);
}

/** Best-effort settle: networkidle then a fixed pause for lazy tiles/images. */
async function settle(page: Page, ms = 2500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Load the exact third-party resources the payment + phone-auth flows would
 * load, without triggering their side effects (orders / SMS). A blocked
 * resource fires a `securitypolicyviolation` our collector records; an allowed
 * one loads silently. Injection mirrors how the app itself adds them
 * (src/lib/razorpay-checkout.ts appends a <script> the same way).
 */
async function probeThirdParty(page: Page) {
  await page
    .evaluate(async () => {
      const addScript = (src: string) =>
        new Promise<void>((resolve) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = () => resolve();
          s.onerror = () => resolve(); // CSP-blocked also fires the violation event
          document.head.appendChild(s);
          setTimeout(resolve, 4000);
        });
      const addIframe = (src: string) =>
        new Promise<void>((resolve) => {
          const f = document.createElement('iframe');
          f.src = src;
          f.style.display = 'none';
          document.body.appendChild(f);
          setTimeout(resolve, 3000);
        });

      // script-src: Razorpay checkout + Firebase phone reCAPTCHA
      await addScript('https://checkout.razorpay.com/v1/checkout.js');
      await addScript('https://www.google.com/recaptcha/api.js');
      // frame-src: Razorpay checkout iframe
      await addIframe('https://checkout.razorpay.com/');
      // connect-src: Razorpay telemetry host (under *.razorpay.com)
      await fetch('https://lumberjack.razorpay.com/v1/track', { mode: 'no-cors' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    })
    .catch(() => {});
}

test.describe('SEC-010 CSP report-only audit', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set CSP_TEST_EMAIL and CSP_TEST_PASSWORD (staging test account) to run this.',
  );

  test('sweep key flows and report CSP violations', async ({ page }) => {
    await installCollector(page);

    // 1) App shell — bundle, CSS, fonts, inline styles
    await page.goto('/');
    await settle(page, 1500);
    await drain(page, 'home / app shell');

    // 2) Login — exercises Firebase auth SDK network calls. Credentials from env.
    await page.goto('/login');
    await page.locator('input[type="email"]').first().fill(EMAIL!);
    await page.locator('input[type="password"]').first().fill(PASSWORD!);
    await page.locator('button[type="submit"]').first().click();
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: 'detached', timeout: 30_000 })
      .catch(() => {
        throw new Error(
          'Login did not complete — check the test credentials, or that the ' +
            'email/password/submit selectors still match src/pages/Login.tsx.',
        );
      });
    await settle(page, 1500);
    await drain(page, 'login (Firebase auth)');

    // 3) Marketplace browse — Google Places, map tiles, media-CDN images
    await page.goto('/explore');
    await settle(page);
    await drain(page, 'explore (maps + images)');

    // 4) Listing detail — map render + provider/listing images from the media CDN.
    // Cards are <button class="stay-card|service-card|transport-card"> that
    // navigate via onClick (not <a href>), so target them by class.
    const card = page.locator('button.stay-card, button.service-card, button.transport-card').first();
    if (await card.count()) {
      await card.click();
      await settle(page);
      await drain(page, 'listing detail (map + images)');
    } else {
      console.log('[CSP] skipped listing detail — no listing cards rendered on /explore');
    }

    // 5) AI assistant — opens the realtime WebSocket (/ws) after minting a ticket
    const assistant = page.getByRole('button', { name: /assistant|sathi|ista ai/i }).first();
    if (await assistant.count()) {
      await assistant.click().catch(() => {});
      await settle(page, 3000);
      await drain(page, 'assistant (WebSocket)');
    } else {
      console.log('[CSP] skipped assistant — open button not found');
    }

    // 6) Synthetic probes for flows the organic sweep can't reach without
    //    side effects (a real Razorpay checkout creates a booking hold + order;
    //    phone reCAPTCHA sends an SMS). Instead we load the EXACT third-party
    //    resources those flows would load — same URLs the app itself uses — and
    //    let the CSP violation events tell us whether the directive allows them.
    //    No orders, no SMS. This deterministically verifies:
    //      • script-src  — Razorpay checkout.js + reCAPTCHA api.js
    //      • frame-src   — Razorpay checkout iframe
    //      • connect-src — Razorpay telemetry (*.razorpay.com)
    await probeThirdParty(page);
    await settle(page, 2000);
    await drain(page, 'synthetic third-party probes (Razorpay + reCAPTCHA)');

    // Note: a REAL Razorpay checkout also loads runtime sub-resources (fonts,
    // cdn.razorpay.com) beyond these hosts. All fall under the *.razorpay.com
    // wildcard, but the gold-standard check is still opening one real checkout
    // on staging with the console open. Same for image upload (posts to
    // same-origin /api/storage/upload → served from *.cloudfront.net, both
    // already allow-listed, so low risk).

    // Summary — unique "directive <- origin" pairs = the exact allowlist gaps.
    const unique = [...new Set(all.map(keyOf))].sort();
    console.log('\n════════ CSP violation summary ════════');
    if (!unique.length) {
      console.log('  none — the report-only policy covered every flow exercised ✅');
      console.log('  (once the opt-in payment/upload flows are covered too, this is safe to enforce)');
    } else {
      console.log('  Add each origin below to the matching directive in the CDK policy:');
      unique.forEach((u) => console.log('  • ' + u));
    }
    console.log('═══════════════════════════════════════\n');

    // Gate: fail if anything fired. Read the printed summary above regardless.
    expect(all, `CSP violations found:\n${unique.join('\n')}`).toHaveLength(0);
  });
});
