import { Router } from 'express';
import { searchController } from '../controllers/search.controller.js';
import { optionalAuth } from '../../../common/auth/require-auth.js';

const router = Router();

router.get('/', searchController.search.bind(searchController));

// Log a date-range selection from a marketplace listing page. optionalAuth so
// the userId is captured when signed in but anonymous browsing still logs.
router.post('/events/date-range', optionalAuth, searchController.logDateRangeEvent.bind(searchController));

export default router;
