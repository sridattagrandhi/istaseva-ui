import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { guaranteesController } from '../controllers/guarantees.controller.js';

const router = Router();

router.post('/', requireAuth, guaranteesController.create.bind(guaranteesController));
router.get('/booking/:bookingId', requireAuth, guaranteesController.getByBookingId.bind(guaranteesController));
router.patch('/:id/claim', requireAuth, guaranteesController.fileClaim.bind(guaranteesController));

export default router;
