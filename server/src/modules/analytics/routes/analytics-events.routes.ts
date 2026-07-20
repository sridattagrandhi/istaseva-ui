import { Router } from 'express';
import { analyticsEventsController } from '../controllers/analytics-events.controller.js';
import { optionalAuth } from '../../../common/auth/require-auth.js';

const router = Router();

// Append behavioural events (listing views, clicks, funnel steps, logins).
// optionalAuth so the userId is captured when signed in but anonymous browsing
// still logs via the client-supplied deviceId.
router.post('/events', optionalAuth, analyticsEventsController.ingest.bind(analyticsEventsController));

export default router;
