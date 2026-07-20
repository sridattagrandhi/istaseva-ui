import express, { Router } from 'express';
import { requireAuth } from '../../../common/auth/require-auth.js';
import { paymentsController } from '../controllers/payments.controller.js';
import { insuranceController } from '../controllers/insurance.controller.js';

const router = Router();

router.post('/create-order', requireAuth, paymentsController.createOrder.bind(paymentsController));
router.post('/verify', requireAuth, paymentsController.verify.bind(paymentsController));
// Webhook must receive the raw body so the HMAC signature can be verified against
// the exact bytes Razorpay signed. The global JSON parser in create-app.ts skips
// this path; express.raw() here delivers req.body as a Buffer.
router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  paymentsController.webhook.bind(paymentsController),
);
router.post('/insurance-policies', requireAuth, insuranceController.createPolicy.bind(insuranceController));

export default router;
