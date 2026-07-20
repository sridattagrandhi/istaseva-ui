// GST state detection for the client-side tax-label preview.
//
// Mirrors `server/src/modules/bookings/services/pricing-breakdown.ts`
// (GST_STATE_CODES / gstStateCodeFromText) and the web copy at
// `src/lib/gst-states.ts` — change all three together. The server
// stays authoritative for the invoice; this only decides whether the booking
// breakdown labels the tax as IGST (inter-state) or CGST+SGST (intra-state).
// The tax AMOUNT is identical either way.

/** GST state codes (the first two digits of a GSTIN) keyed by lowercase state/UT name. */
export const GST_STATE_CODES: Record<string, string> = {
  "jammu and kashmir": "01", "himachal pradesh": "02", "punjab": "03",
  "chandigarh": "04", "uttarakhand": "05", "haryana": "06", "delhi": "07",
  "rajasthan": "08", "uttar pradesh": "09", "bihar": "10", "sikkim": "11",
  "arunachal pradesh": "12", "nagaland": "13", "manipur": "14", "mizoram": "15",
  "tripura": "16", "meghalaya": "17", "assam": "18", "west bengal": "19",
  "jharkhand": "20", "odisha": "21", "orissa": "21", "chhattisgarh": "22",
  "madhya pradesh": "23", "gujarat": "24",
  "dadra and nagar haveli and daman and diu": "26", "daman and diu": "26",
  "maharashtra": "27", "karnataka": "29", "goa": "30", "lakshadweep": "31",
  "kerala": "32", "tamil nadu": "33", "puducherry": "34", "pondicherry": "34",
  "andaman and nicobar islands": "35", "telangana": "36", "andhra pradesh": "37",
  "ladakh": "38",
};

/** Best-effort GST state code from free text (address / listing location).
 *  Longest state-name match wins; null when no state name appears. */
export function gstStateCodeFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const hay = ` ${String(text).toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, code] of Object.entries(GST_STATE_CODES)) {
    if (name.length > bestLen && hay.includes(` ${name} `)) {
      best = code;
      bestLen = name.length;
    }
  }
  return best;
}

/** True only when BOTH texts resolve to a state and the states differ.
 *  Unknown on either side → false (intra-state CGST+SGST, the safe default —
 *  matches the server's `isInterState`). */
export function isInterStateText(listingText: string | null | undefined, customerText: string | null | undefined): boolean {
  const a = gstStateCodeFromText(listingText);
  const b = gstStateCodeFromText(customerText);
  return Boolean(a && b && a !== b);
}

/** Split a displayed tax amount (rupees) for the breakdown rows: IGST keeps
 *  the full amount; CGST/SGST get half each with SGST absorbing the odd
 *  paisa — mirrors the server invoice's split. */
export function splitTax(taxes: number, interState: boolean): { cgst: number; sgst: number; igst: number } {
  if (interState) return { cgst: 0, sgst: 0, igst: taxes };
  const cgst = Math.round((taxes / 2) * 100) / 100;
  return { cgst, sgst: Math.round((taxes - cgst) * 100) / 100, igst: 0 };
}

/** "9" for 18% halves, "2.5" for 5% halves — no trailing ".0". */
export function halfPctLabel(rate: number): string {
  const p = rate * 50;
  return Number.isInteger(p) ? String(p) : String(Math.round(p * 10) / 10);
}

/** "18" / "5" — the full GST percentage for IGST labels. */
export function fullPctLabel(rate: number): string {
  const p = rate * 100;
  return Number.isInteger(p) ? String(p) : String(Math.round(p * 10) / 10);
}
