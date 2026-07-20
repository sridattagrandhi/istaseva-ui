import { Router } from 'express';
import { translationController } from '../controllers/translation.controller.js';

const router = Router();

// No auth — translations are idempotent reads of public content, and the
// cache + provider are the natural rate-limit boundary.
router.post('/translate', translationController.translate.bind(translationController));

export default router;
