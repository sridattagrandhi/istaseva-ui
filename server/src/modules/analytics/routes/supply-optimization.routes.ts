import { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { supplyOptimizationController } from '../controllers/supply-optimization.controller.js';

const router = Router();

// Auth required — this is platform analytics/ops data, not public content. The
// `recalculate` action additionally requires admin (enforced in the controller);
// it triggers a platform-wide metrics recompute that also runs on a 15-min job,
// so an anonymous caller looping it was a cost/DoS vector.
router.get('/', requireAuth, supplyOptimizationController.getMetrics.bind(supplyOptimizationController));

export default router;
