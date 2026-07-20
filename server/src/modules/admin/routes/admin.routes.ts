import { Router } from 'express';
import { requireAuth, requireRole } from '../../../common/auth/require-auth.js';
import { adminAuditController } from '../controllers/admin-audit.controller.js';
import { adminBookingsController } from '../controllers/admin-bookings.controller.js';
import { adminCouponsController } from '../controllers/admin-coupons.controller.js';
import { adminFacetsController } from '../controllers/admin-facets.controller.js';
import { adminFeesController } from '../controllers/admin-fees.controller.js';
import { adminFraudController } from '../controllers/admin-fraud.controller.js';
import { adminListingsController } from '../controllers/admin-listings.controller.js';
import { adminMetricsController } from '../controllers/admin-metrics.controller.js';
import { adminPayoutsController } from '../controllers/admin-payouts.controller.js';
import { adminUsersController } from '../controllers/admin-users.controller.js';

const router = Router();

// Every admin route is gated by an authenticated user carrying the `admin`
// role (Firebase custom claim → req.user.role).
router.use(requireAuth, requireRole('admin'));

router.get('/metrics/overview', adminMetricsController.overview.bind(adminMetricsController));
router.get('/metrics/funnel', adminMetricsController.funnel.bind(adminMetricsController));
router.get('/metrics/search-terms', adminMetricsController.searchTerms.bind(adminMetricsController));
router.get('/metrics/engagement', adminMetricsController.engagement.bind(adminMetricsController));
router.get('/metrics/geo', adminMetricsController.geo.bind(adminMetricsController));
router.get('/metrics/bookings', adminMetricsController.filteredBookings.bind(adminMetricsController));
router.get('/metrics/providers', adminMetricsController.filteredProviders.bind(adminMetricsController));
router.get('/metrics/acquisition', adminMetricsController.acquisition.bind(adminMetricsController));
router.get('/metrics/customers', adminMetricsController.customers.bind(adminMetricsController));
router.get('/metrics/languages', adminMetricsController.languages.bind(adminMetricsController));
router.get('/metrics/origins', adminMetricsController.origins.bind(adminMetricsController));
router.get('/metrics/origin-dest', adminMetricsController.originDest.bind(adminMetricsController));
router.get('/metrics/payment-failures', adminMetricsController.paymentFailures.bind(adminMetricsController));
router.get('/metrics/cancel-reasons', adminMetricsController.cancelReasons.bind(adminMetricsController));
router.get('/metrics/freshness', adminMetricsController.freshness.bind(adminMetricsController));

// Revenue drill-down — payments joined to bookings/listings (transactional
// source of truth), sliceable by type/category/city/state/host. Powers the
// interactive Revenue explorer (click a segment → trend + top listings).
router.get('/metrics/revenue/summary', adminMetricsController.revenueSummary.bind(adminMetricsController));
router.get('/metrics/revenue/breakdown', adminMetricsController.revenueBreakdown.bind(adminMetricsController));
router.get('/metrics/revenue/series', adminMetricsController.revenueSeries.bind(adminMetricsController));
router.get('/metrics/revenue/listings', adminMetricsController.revenueListings.bind(adminMetricsController));

// Ops console — filter-option sources (distinct listing states/cities/
// types/categories) for the multi-select pickers.
router.get('/facets', adminFacetsController.listingFacets.bind(adminFacetsController));

// Ops console — audit trail. Actions = Postgres admin_actions (admin
// mutations, multi-axis filters); events = DynamoDB audit_events passthrough
// (per-user / per-resource entity timelines).
router.get('/audit/actions', adminAuditController.listActions.bind(adminAuditController));
router.get('/audit/events', adminAuditController.listEvents.bind(adminAuditController));

// Ops console — fraud investigation (Postgres mirror of the DynamoDB stream).
router.get('/fraud/signals', adminFraudController.listSignals.bind(adminFraudController));
router.get('/fraud/event-types', adminFraudController.listEventTypes.bind(adminFraudController));
router.get('/fraud/users/:userId', adminFraudController.userDossier.bind(adminFraudController));

// Ops console — user suspension (blocks auth via require-auth cache + IdP disable).
router.get('/users', adminUsersController.search.bind(adminUsersController));
router.get('/users/:userId', adminUsersController.get.bind(adminUsersController));
router.post('/users/:userId/suspend', adminUsersController.suspend.bind(adminUsersController));
router.post('/users/:userId/unsuspend', adminUsersController.unsuspend.bind(adminUsersController));
// LEG-003 takedown: suspend + schedule the standard account erasure.
router.post('/users/:userId/request-deletion', adminUsersController.requestDeletion.bind(adminUsersController));

// Ops console — booking lookup + intervention (cancel with policy/full refund).
router.get('/bookings', adminBookingsController.search.bind(adminBookingsController));
router.post('/bookings/on-behalf', adminBookingsController.createOnBehalf.bind(adminBookingsController));
router.get('/bookings/:id', adminBookingsController.detail.bind(adminBookingsController));
router.post('/bookings/:id/cancel', adminBookingsController.cancel.bind(adminBookingsController));

// Ops console — coupons: platform-wide creation + moderation over all coupons.
router.get('/coupons', adminCouponsController.list.bind(adminCouponsController));
router.get('/coupons/:id', adminCouponsController.detail.bind(adminCouponsController));
router.post('/coupons', adminCouponsController.create.bind(adminCouponsController));
router.patch('/coupons/:id', adminCouponsController.setActive.bind(adminCouponsController));

// Ops console — platform-fee rules (the Fees panel). Rules are append-only:
// create + deactivate, never edit. Simulator answers "which rule would win
// and what would this booking cost" before an admin publishes anything.
router.get('/fees/rules', adminFeesController.listRules.bind(adminFeesController));
router.post('/fees/rules', adminFeesController.createRule.bind(adminFeesController));
router.post('/fees/rules/:id/replace', adminFeesController.replaceRule.bind(adminFeesController));
router.post('/fees/rules/:id/deactivate', adminFeesController.deactivateRule.bind(adminFeesController));
router.get('/fees/tiers', adminFeesController.listTiers.bind(adminFeesController));
router.post('/fees/tiers', adminFeesController.upsertTier.bind(adminFeesController));
router.delete('/fees/tiers/:id', adminFeesController.deleteTier.bind(adminFeesController));
router.post('/fees/simulate', adminFeesController.simulate.bind(adminFeesController));

// Ops console — payouts ledger: who is owed what (completed + paid +
// unrefunded bookings not yet covered), record-a-payout (manual money
// movement for now; RazorpayX executor will write the same rows), history.
router.get('/payouts/summary', adminPayoutsController.summary.bind(adminPayoutsController));
router.get('/payouts/partner/:userId/businesses', adminPayoutsController.partnerBusinesses.bind(adminPayoutsController));
router.get('/payouts', adminPayoutsController.ledger.bind(adminPayoutsController));
router.post('/payouts', adminPayoutsController.record.bind(adminPayoutsController));

// Ops console — listing search + ban (separate state from host-controlled is_active).
router.get('/listings', adminListingsController.search.bind(adminListingsController));
router.post('/listings/for-user', adminListingsController.createForUser.bind(adminListingsController));
router.get('/listings/:id', adminListingsController.detail.bind(adminListingsController));
router.post('/listings/:id/ban', adminListingsController.ban.bind(adminListingsController));
router.post('/listings/:id/unban', adminListingsController.unban.bind(adminListingsController));
// Takedown ("delete") = soft archive — the ONLY listing-removal path on the
// platform (self-serve host/provider/driver delete was removed 2026-07).
router.post('/listings/:id/archive', adminListingsController.archive.bind(adminListingsController));
router.post('/listings/:id/unarchive', adminListingsController.unarchive.bind(adminListingsController));

export default router;
