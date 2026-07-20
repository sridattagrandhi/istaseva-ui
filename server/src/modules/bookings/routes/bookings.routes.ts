import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { bookingsController } from '../controllers/bookings.controller.js';

const router = Router();

router.get('/', requireAuth, bookingsController.list.bind(bookingsController));
router.post('/holds', requireAuth, bookingsController.create.bind(bookingsController));
router.post('/prepare', requireAuth, bookingsController.prepare.bind(bookingsController));
router.post('/on-behalf', requireAuth, bookingsController.createOnBehalf.bind(bookingsController));
router.delete('/holds/:id', requireAuth, bookingsController.releaseHold.bind(bookingsController));
router.post('/', requireAuth, bookingsController.create.bind(bookingsController));
// Must precede '/:id' so 'relationship' isn't captured as a booking id.
router.get('/relationship', requireAuth, bookingsController.getRelationship.bind(bookingsController));
router.get('/:id', requireAuth, bookingsController.getById.bind(bookingsController));
router.get('/:id/cancel-preview', requireAuth, bookingsController.cancelPreview.bind(bookingsController));
router.get('/:id/invoice.pdf', requireAuth, bookingsController.downloadInvoice.bind(bookingsController));
router.patch('/:id/status', requireAuth, bookingsController.updateStatus.bind(bookingsController));
export default router;
