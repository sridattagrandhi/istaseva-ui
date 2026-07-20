import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { couponsController } from '../controllers/coupons.controller.js';

const router = Router();

// Guest-facing preview: requires auth so rate-limits apply & we can log who
// is probing codes, but doesn't restrict by role.
router.get('/validate', requireAuth, couponsController.validate.bind(couponsController));

// Host CRUD
router.get('/', requireAuth, couponsController.list.bind(couponsController));
router.post('/', requireAuth, couponsController.create.bind(couponsController));
router.patch('/:id', requireAuth, couponsController.toggleActive.bind(couponsController));
router.delete('/:id', requireAuth, couponsController.delete.bind(couponsController));

export default router;
