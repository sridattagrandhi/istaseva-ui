import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../../common/auth/require-auth.js';
import { listingsController } from '../controllers/listings.controller.js';

const router = Router();

router.get('/', listingsController.list.bind(listingsController));
router.get('/taxonomy', listingsController.taxonomy.bind(listingsController));
router.get('/mine', requireAuth, listingsController.mine.bind(listingsController));
router.get('/:id/booked-dates', listingsController.bookedDates.bind(listingsController));
router.get('/:id/fee-quote', listingsController.feeQuote.bind(listingsController));
router.get('/:id/room-availability', listingsController.roomAvailability.bind(listingsController));
router.get('/:id/transport-bookings', listingsController.transportBookings.bind(listingsController));
router.get('/:id/service-bookings', listingsController.serviceBookings.bind(listingsController));
router.get('/:id/availability', listingsController.listAvailability.bind(listingsController));
router.put('/:id/availability', requireAuth, listingsController.setAvailability.bind(listingsController));
router.get('/:id/readiness', requireAuth, listingsController.readiness.bind(listingsController));
router.get('/:id/room-types', listingsController.listRoomTypes.bind(listingsController));
router.post('/:id/room-types', requireAuth, listingsController.createRoomType.bind(listingsController));
router.patch('/:id/room-types/:roomId', requireAuth, listingsController.updateRoomType.bind(listingsController));
router.delete('/:id/room-types/:roomId', requireAuth, listingsController.deleteRoomType.bind(listingsController));
// optionalAuth so banned listings 404 for the public while remaining visible
// to their owner (dashboard shows the ban notice) and to admins.
router.get('/:id', optionalAuth, listingsController.getById.bind(listingsController));
router.post('/', requireAuth, listingsController.create.bind(listingsController));
router.patch('/:id', requireAuth, listingsController.update.bind(listingsController));
// Self-serve listing deletion is intentionally GONE (2026-07): hosts/providers/
// drivers deactivate; only admins remove listings, via the soft-archive
// endpoint under /api/admin/listings (records retained for bookings/invoices).

export default router;
