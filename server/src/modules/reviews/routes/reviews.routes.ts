import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { reviewsController } from '../controllers/reviews.controller.js';

const router = Router();

router.get('/stay/:stayId', reviewsController.listByStay.bind(reviewsController));
router.get('/listing/:listingId', reviewsController.listByListing.bind(reviewsController));
// Finished-but-unreviewed bookings for the signed-in user — feeds the
// post-completion "rate your stay" prompt on app open (web + mobile).
router.get('/me/pending', requireAuth, reviewsController.pendingPrompts.bind(reviewsController));
router.post('/', requireAuth, reviewsController.create.bind(reviewsController));
router.patch('/:id/helpful', requireAuth, reviewsController.markHelpful.bind(reviewsController));

export default router;
