/**
 * Tool registry for the assistant agent.
 *
 * Phase 1 shipped read-only tools. Phase 2 adds:
 *   - prepare_booking — creates a real hold + Razorpay order; user
 *     confirms by tapping the inline card (money only moves there).
 *   - cancel_booking_preview, message_host_preview — read-only previews
 *     that the agent surfaces to the user via a confirm-card action.
 *     The actual mutation is fired by the frontend on user confirm.
 *   - escalate_to_human — telemetry stub + navigation hint.
 *   - remember_preference — Phase 4 wires real storage; stub today.
 *
 * The read/write split lets the loop apply different policies
 * (parallel vs sequential, audit logging) per category in later phases.
 */
import type { ToolDefinition } from '../types.js';
import { searchListingsTool } from './search-listings.tool.js';
import { getListingDetailsTool } from './get-listing-details.tool.js';
import { checkAvailabilityTool } from './check-availability.tool.js';
import { getUserBookingsTool } from './get-user-bookings.tool.js';
import { cancelBookingPreviewTool } from './cancel-booking-preview.tool.js';
import { messageHostPreviewTool } from './message-host-preview.tool.js';
import { escalateToHumanTool } from './escalate-to-human.tool.js';
import { rememberPreferenceTool } from './remember-preference.tool.js';
import { prepareBookingTool } from './prepare-booking.tool.js';
import { toggleWishlistTool } from './toggle-wishlist.tool.js';
import { getListingReviewsTool } from './get-listing-reviews.tool.js';
import { findAvailableSlotsTool } from './find-available-slots.tool.js';
import { findNextAvailabilityTool } from './find-next-availability.tool.js';
import { getAvailabilityOverviewTool } from './get-availability-overview.tool.js';
import { modifyBookingTool } from './modify-booking.tool.js';
import { getStayPricingPreviewTool } from './get-stay-pricing-preview.tool.js';
import { getBookingPricePreviewTool } from './get-booking-price-preview.tool.js';
import { getSavedListingsTool } from './get-saved-listings.tool.js';
import { getBookingInsightsTool } from './get-booking-insights.tool.js';
import { openListingTool } from './open-listing.tool.js';
import { filterMarketplaceTool } from './filter-marketplace.tool.js';
import { locateListingTool } from './locate-listing.tool.js';
import { resolveAddressTool } from './resolve-address.tool.js';

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  searchListingsTool as ToolDefinition,
  getListingDetailsTool as ToolDefinition,
  checkAvailabilityTool as ToolDefinition,
  getUserBookingsTool as ToolDefinition,
  cancelBookingPreviewTool as ToolDefinition,
  messageHostPreviewTool as ToolDefinition,
  // Recent reviews for the listing the user's looking at — read-only,
  // public-data, useful when the user is comparing or hesitating.
  getListingReviewsTool as ToolDefinition,
  // Real open time-slots for services/transport — lets the agent surface
  // concrete options instead of asking the user to guess a time.
  findAvailableSlotsTool as ToolDefinition,
  // "When's the SOONEST I can book X?" — walks forward across all
  // mode-matching listings and returns the earliest genuinely-free date +
  // top options. The capability the agent lacked: it used to guess "today"
  // or pitch a day-rate driver for an hourly ask. Mode-aware end to end.
  findNextAvailabilityTool as ToolDefinition,
  // "What dates are available?" — per-day rollup over N days. Closes the
  // tool gap that used to force the agent to bounce the question back as
  // "what dates were you thinking?" when the user wanted to explore first.
  getAvailabilityOverviewTool as ToolDefinition,
  // Non-mutating stay pricing preview — applies host overrides + platform fee
  // + GST exactly like createHold, so the agent can quote a real number and
  // get confirmation BEFORE locking a slot.
  getStayPricingPreviewTool as ToolDefinition,
  // Same idea, services + transport. Required before prepare_booking for
  // those categories so the user sees the real total first.
  getBookingPricePreviewTool as ToolDefinition,
  // "Show me my saved listings" — read-only hydrated wishlist.
  getSavedListingsTool as ToolDefinition,
  // "How much have I spent / when's my next trip / summarise my bookings" —
  // aggregates (spend, counts, next trip) so the agent answers with real
  // numbers instead of adding up the raw list.
  getBookingInsightsTool as ToolDefinition,
  // "Take me to the listing page" — when the user picked self-book or
  // explicitly asked to open the detail page. Validates the id against
  // the DB and returns the navigation target; user-assistant.service.ts
  // promotes a successful call into the final response's action.
  openListingTool as ToolDefinition,
  // "Filter this page to X" — narrows the marketplace grid the user is
  // browsing IN PLACE. Promoted to the apply_filters action; the web client
  // drives the live filter state (falls back to filtered-page nav off-page).
  filterMarketplaceTool as ToolDefinition,
  // "Where is X / show me X on the list" — scrolls to + flashes a listing
  // card on the current grid. Promoted to highlight_listing; falls back to
  // opening the detail page when the card isn't on screen.
  locateListingTool as ToolDefinition,
  // Map-verify a customer-given address (at-home / pickup) and hand back the
  // canonical formattedAddress to echo for confirmation. Read-only; the
  // at-home hold is ALSO gated server-side in assistant-booking.service.
  resolveAddressTool as ToolDefinition,
];

export const WRITE_TOOLS: ToolDefinition[] = [
  // prepare_booking is back. It creates a 5-min slot hold + Razorpay order
  // but DOES NOT take money — the user's tap on the inline Confirm & Pay
  // card is what triggers payment. So the legal/consent gate is satisfied
  // (final action = user's tap) while the agent does the actual work
  // (assembling the booking summary). Calling this without an explicit
  // user "yes book it" is a prompt-side bug, not a code one — the tool's
  // own description enforces that gate.
  prepareBookingTool as ToolDefinition,
  escalateToHumanTool as ToolDefinition,
  rememberPreferenceTool as ToolDefinition,
  // "Save this" / "favorite it" — user-scoped, idempotent both directions.
  toggleWishlistTool as ToolDefinition,
  // Cancel an existing booking from chat.
  modifyBookingTool as ToolDefinition,
];

/** Default set the agent loop is given on a `respond()` call. Phase 2 ships
 *  read + write together — the prompt teaches the model when each is safe. */
export const DEFAULT_TOOLS: ToolDefinition[] = [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

/** Lookup table by tool name for the agent loop's dispatch step. Built
 *  from DEFAULT_TOOLS so any tool reachable by the model is dispatchable. */
export const TOOLS_BY_NAME: Record<string, ToolDefinition> = Object.fromEntries(
  DEFAULT_TOOLS.map((t) => [t.name, t]),
);

/**
 * Tools restricted to specific roles. Every current tool is guest-safe
 * (self-scoped via ctx.userId), so the map starts empty — but the gate is
 * enforced NOW so the first host/provider-only tool (block dates, edit
 * listing, …) can declare its roles here instead of shipping visible to
 * every guest by accident.
 */
const TOOL_ROLE_RESTRICTIONS: Record<string, ReadonlyArray<string>> = {
  // example: block_listing_dates: ['host', 'provider'],
};

/** The tool set a given user role may see and call. Used by respond() when
 *  declaring tools to the model — an undeclared tool is also undispatchable
 *  because the loop resolves calls against this same filtered set. */
export function toolsForRole(role?: string): ToolDefinition[] {
  return DEFAULT_TOOLS.filter((t) => {
    const allowed = TOOL_ROLE_RESTRICTIONS[t.name];
    return !allowed || (role != null && allowed.includes(role));
  });
}
