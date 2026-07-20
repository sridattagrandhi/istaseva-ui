import { Router } from 'express';
import { geocodeController } from '../controllers/geocode.controller.js';

const router = Router();

// No auth — geocoding is idempotent on a public address string. The Redis
// cache + provider rate limits are the natural protection. If abuse becomes
// a concern, drop a per-IP rate limiter here.
router.post('/', geocodeController.geocode.bind(geocodeController));
router.post('/autocomplete', geocodeController.autocomplete.bind(geocodeController));
router.post('/place-details', geocodeController.placeDetails.bind(geocodeController));

export default router;
