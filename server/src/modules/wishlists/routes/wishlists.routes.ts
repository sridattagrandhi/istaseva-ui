import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { wishlistsController } from '../controllers/wishlists.controller.js';

const router = Router();

// Everything requires auth — a wishlist is inherently user-scoped.
router.get('/', requireAuth, wishlistsController.list.bind(wishlistsController));
router.post('/', requireAuth, wishlistsController.add.bind(wishlistsController));
router.delete('/:listingType/:listingId', requireAuth, wishlistsController.remove.bind(wishlistsController));

export default router;
