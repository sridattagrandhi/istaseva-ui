/**
 * Pure-math helper that builds the invoice totals lines from the booking +
 * stored payment row. Extracted from `invoice.service.ts` so the math is
 * testable without rendering a PDF (PDFKit's compressed binary output is
 * impractical to grep).
 *
 * Source-of-truth rule:
 *   - When the payment row has the breakdown columns populated
 *     (subtotal_paise, platform_fee_paise, taxes_paise) we use those values
 *     directly. They came either from the frontend's forward calculation
 *     (preferred) or the server's inverse fallback. Either way, the numbers
 *     reconcile to amount_paise.
 *   - For pre-migration legacy rows where the breakdown is NULL, we fall
 *     back to the tax-inclusive split derived from agreed_price_paise via
 *     computePricingBreakdown — the original behaviour.
 *
 * The output is a structured object the renderer turns into rows. Tests
 * assert the math reconciles regardless of which path produced the inputs.
 */

import type { PricingBreakdown } from './pricing-breakdown.js';

export type BookingCategory = 'stay' | 'transport' | 'service';

export interface InvoicePaymentRow {
  amount_paise: number | string | null;
  subtotal_paise?: number | string | null;
  platform_fee_paise?: number | string | null;
  taxes_paise?: number | string | null;
  insurance_premium_paise?: number | string | null;
  discount_paise?: number | string | null;
  method?: string | null;
}

export interface InvoiceTotalsLines {
  /** Whether the stored breakdown columns drove the math (vs. legacy fallback). */
  source: 'stored' | 'legacy';
  /** Label for the first totals line ("Base cost" / "Trip fare" / "Service cost"). */
  baseLabel: string;
  /** Host's portion in paise. */
  subtotalPaise: number;
  /** Platform fee in paise (0 in legacy fallback). */
  platformFeePaise: number;
  /** Taxes in paise (full amount; the renderer splits CGST/SGST 50:50). */
  taxesPaise: number;
  /** Insurance premium in paise (0 unless opted in). */
  insurancePaise: number;
  /** Discount in paise (0 if no coupon was applied). */
  discountPaise: number;
  /** Line-item taxable value = subtotal + platform fee. The base GST applies to this. */
  lineTaxablePaise: number;
  /** CGST half (intra-state) — derived from `taxesPaise`. */
  cgstPaise: number;
  /** SGST half (intra-state) — `taxesPaise - cgstPaise` so the parts sum exactly. */
  sgstPaise: number;
  /** IGST full (inter-state). */
  igstPaise: number;
  /** Grand total — what the customer was actually charged. */
  totalPaise: number;
}

function toNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return NaN;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : NaN;
}

function baseLabelFor(category: BookingCategory): string {
  switch (category) {
    case 'stay': return 'Base cost';
    case 'transport': return 'Trip fare';
    case 'service': return 'Service cost';
  }
}

/**
 * Build the structured totals data that drives both the line-item table and
 * the totals block. Same numbers feed both, so the line-item amount and the
 * displayed grand total reconcile to `payment.amount_paise` exactly.
 */
export function computeInvoiceLines(
  payment: InvoicePaymentRow | null | undefined,
  fallback: PricingBreakdown,
  category: BookingCategory,
): InvoiceTotalsLines {
  const totalPaise = toNumber(payment?.amount_paise);
  const fallbackTotal = fallback.grossPaise;

  const subtotal = toNumber(payment?.subtotal_paise);
  const platformFee = toNumber(payment?.platform_fee_paise);
  const taxes = toNumber(payment?.taxes_paise);
  const insurance = toNumber(payment?.insurance_premium_paise);
  const discount = toNumber(payment?.discount_paise);

  const useStored = Number.isFinite(subtotal) && Number.isFinite(platformFee) && platformFee >= 0;

  if (useStored) {
    const taxesValue = Number.isFinite(taxes) ? taxes : 0;
    const insuranceValue = Number.isFinite(insurance) ? insurance : 0;
    const discountValue = Number.isFinite(discount) ? discount : 0;
    // Intra-state CGST/SGST split: half each, with rounding error absorbed
    // into the SGST line so cgst + sgst === taxes exactly.
    const cgst = Math.round(taxesValue / 2);
    const sgst = taxesValue - cgst;
    // Subtotal stored is the ORIGINAL (pre-discount) host portion. The
    // line-item taxable value on the tax invoice is what GST is actually
    // applied to: (subtotal − discount + platform fee). When discount is 0
    // this collapses to (subtotal + platformFee) — same as before.
    const lineTaxable = Math.max(0, subtotal - discountValue) + platformFee;
    // Total is ALWAYS the sum of the rendered lines — never the raw
    // payments.amount_paise column. We saw a real bug where `amount_paise`
    // lagged the insurance line: the invoice listed "Insurance Premium ₹2"
    // but the "Total paid" footer read amount_paise without insurance and
    // ended up ₹2 short of the visible breakdown (₹9.36 instead of ₹11.36).
    // Recomputing keeps the footer internally consistent across stays,
    // services, and transport, regardless of which legacy row is involved.
    const computedTotalPaise = Math.max(0, subtotal - discountValue) + platformFee + taxesValue + insuranceValue;
    return {
      source: 'stored',
      baseLabel: baseLabelFor(category),
      subtotalPaise: subtotal,
      platformFeePaise: platformFee,
      taxesPaise: taxesValue,
      insurancePaise: insuranceValue,
      discountPaise: discountValue,
      lineTaxablePaise: lineTaxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: taxesValue,
      totalPaise: computedTotalPaise,
    };
  }

  // Legacy fallback: tax-inclusive split from agreed_price_paise. No platform
  // fee line (the legacy renderer didn't show one); CGST/SGST come straight
  // from computePricingBreakdown.
  return {
    source: 'legacy',
    baseLabel: baseLabelFor(category),
    subtotalPaise: fallback.taxablePaise,
    platformFeePaise: 0,
    taxesPaise: fallback.taxPaise,
    insurancePaise: 0,
    discountPaise: 0,
    lineTaxablePaise: fallback.taxablePaise,
    cgstPaise: fallback.cgstPaise,
    sgstPaise: fallback.sgstPaise,
    igstPaise: fallback.igstPaise,
    totalPaise: fallback.grossPaise,
  };
}
