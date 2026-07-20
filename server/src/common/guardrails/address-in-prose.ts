/**
 * Address-in-prose detection (WS6 follow-up).
 *
 * The structured geo fields are masked on public reads, but title/description
 * are host-authored free prose rendered to every browser — a host who types
 * their full street address there publishes it pre-booking. This scan powers
 * a WARN-ONLY guardrail: the listing still saves; the host is nudged to move
 * the address into the location field, where it is only shared with
 * confirmed guests.
 *
 * Deliberately conservative — the harmful pattern is a COMPLETE address, not
 * a neighbourhood reference. "near Tirumala By-pass Road" or "5 minutes from
 * the temple" must NOT trigger; "D.No 12/4, Temple Street" or a PIN code
 * should. Two independent signals, either one fires:
 *   1. An Indian PIN code (6 digits, not part of a price/phone/bigger number).
 *   2. A door/plot/flat number attached to a road-ish word.
 */
import type { GuardrailIssue } from './prohibited-content.js';

// 6-digit PIN starting 1-9, not preceded by currency/digits (price like
// "₹150000" or "Rs 250000") and not inside a longer digit run (phone numbers).
const PIN_CODE = /(?<![₹0-9,.])(?<!(?:rs|inr)[\s.]{0,3})\b[1-9][0-9]{5}\b(?![0-9])/i;

// "D.No 12", "H.No 4-2", "Plot 17", "Flat No 3B", "#12" … or a bare number
// followed (within a couple of words) by road/street/lane/marg/cross/main.
const DOOR_NUMBER =
  /\b(?:h\.?\s?no\.?|d\.?\s?no\.?|door\s+no\.?|plot\s+(?:no\.?\s*)?|flat\s+(?:no\.?\s*)?|#)\s*\d+[\w/-]*/i;
const NUMBER_THEN_ROAD =
  /\b\d{1,4}(?:[/-]\d{1,4})?(?:\s*,\s*|\s+)(?:[a-z]+\s+){0,3}(?:road|rd\.?|street|st\.?|lane|marg|cross|main)\b/i;

/** True when the text looks like it contains a complete street address. */
export function looksLikeStreetAddress(text: string): boolean {
  return PIN_CODE.test(text) || DOOR_NUMBER.test(text) || NUMBER_THEN_ROAD.test(text);
}

/**
 * Warn-only issues for prose fields (name/title/description). Callers must
 * treat severity:'warn' as non-blocking — the copy tells the host where the
 * address actually belongs.
 */
export function scanAddressInProse(field: string, value: unknown): GuardrailIssue[] {
  if (typeof value !== 'string' || !looksLikeStreetAddress(value)) return [];
  return [{
    field,
    code: 'address_in_prose',
    severity: 'warn',
    message:
      `Your ${field} appears to contain a street address, which is visible to everyone browsing. `
      + `For your safety, put the full address in the location field instead — there it is only shared `
      + `with confirmed guests.`,
  }];
}
