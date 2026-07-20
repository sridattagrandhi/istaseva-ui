/**
 * Re-export all domain services as React-friendly hooks / accessors.
 * 
 * Components should import from here rather than directly from domain services,
 * keeping the import path consistent and enabling future React Query integration.
 */

export { getBookingService } from '@/domains/bookings/booking.service';
export { getPaymentService } from '@/domains/payments/payment.service';
export { getUserService } from '@/domains/users/user.service';
export { getProviderService } from '@/domains/providers/provider.service';
export { getListingService } from '@/domains/listings/listing.service';
export { getReviewService } from '@/domains/reviews/review.service';
export { getChatService } from '@/domains/chat/chat.service';
export { getNotificationService } from '@/domains/notifications/notification.service';
export { getGuaranteeService } from '@/domains/guarantees/guarantee.service';
export { getInsuranceService } from '@/domains/insurance/insurance.service';
export { getVerificationService } from '@/domains/verification/verification.service';
export { getSafetyService } from '@/domains/safety/safety.service';
export { getPricingService } from '@/domains/pricing/pricing.service';
export { getFraudService } from '@/domains/fraud/fraud.service';
export { getAuditService } from '@/domains/audit/audit.service';
export { getLegalService } from '@/domains/legal/legal.service';

// Provider access
export {
  getAuthProvider,
  getRealtimeProvider,
  getAnalyticsProvider,
} from '@/config/providers';
