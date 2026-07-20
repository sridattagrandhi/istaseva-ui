/**
 * Domain Services — Barrel Export
 * 
 * CORE TRANSACTIONAL (keep together in monolith):
 *   - bookings, payments, listings, providers, users, 
 *     guarantees, insurance, pricing, reviews, safety
 * 
 * SEPARABLE (extract into microservices later):
 *   - chat, notifications, fraud, audit, analytics,
 *     search, verification/KYC, legal
 */

// ── Core Transactional ──
export { getBookingService } from './bookings/booking.service';
export { getPaymentService } from './payments/payment.service';
export { getUserService } from './users/user.service';
export { getProviderService } from './providers/provider.service';
export { getListingService } from './listings/listing.service';
export { getReviewService } from './reviews/review.service';
export { getGuaranteeService } from './guarantees/guarantee.service';
export { getInsuranceService } from './insurance/insurance.service';
export { getPricingService } from './pricing/pricing.service';
export { getSafetyService } from './safety/safety.service';

// ── Separable Services ──
export { getChatService } from './chat/chat.service';
export { getNotificationService } from './notifications/notification.service';
export { getFraudService } from './fraud/fraud.service';
export { getAuditService } from './audit/audit.service';
export { getPlatformAnalyticsService } from './analytics/platform-analytics.service';
export { getVerificationService } from './verification/verification.service';
export { getLegalService } from './legal/legal.service';
