/**
 * Domain Types
 * 
 * Core domain entities, enums, and status machines.
 * These are provider-agnostic — no Supabase or AWS types here.
 */

// ============ Common ============

export type UUID = string;
export type ISOTimestamp = string;
export type Currency = 'INR' | 'USD';

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  /**
   * Structured error payload from the backend (e.g. the listing readiness
   * `missing` array). Present only when the server returned `error.details`.
   */
  errorDetails?: unknown;
}

// ============ Auth ============

export interface AuthUser {
  id: UUID;
  email: string;
  emailVerified: boolean;
  phone?: string;
  phoneVerified?: boolean;
  metadata?: Record<string, any>;
  createdAt: ISOTimestamp;
  /** Per-user KYC status. Lives on user_profiles; hydrated by AuthContext. */
  verificationStatus?: VerificationStatus;
  /** Timestamp of last verification approval, if any. */
  verifiedAt?: ISOTimestamp;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

// ============ Users ============

export interface UserProfile {
  id: UUID;
  userId: UUID;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  phone?: string;
  location?: string;
  preferredLanguage: string;
  /** Per-user KYC status — moved off provider_profiles in May 2026. */
  verificationStatus?: VerificationStatus;
  verifiedAt?: ISOTimestamp;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

// ============ Providers ============

export type VerificationStatus = 'pending' | 'submitted' | 'verified' | 'rejected';
export type BookingMode = 'instant' | 'manual_approval';

export interface ProviderProfile {
  id: UUID;
  userId: UUID;
  displayName: string;
  serviceCategories: string[];
  lat?: number;
  lng?: number;
  serviceRadiusKm: number;
  bufferMinutes: number;
  isAvailable: boolean;
  bio?: string;
  bookingMode: BookingMode;
  bookingRules: BookingRules;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface BookingRules {
  maxAdvanceDays: number;
  minNoticeHours: number;
  autoConfirmReturning: boolean;
}

// ============ Listings ============

export interface Listing {
  id: UUID;
  userId: UUID;
  providerProfileId?: UUID;
  category: string;
  name: string;
  description?: string;
  location?: string;
  lat?: number;
  lng?: number;
  serviceArea?: string;
  price?: string;
  availability?: string;
  photos: string[];
  amenities?: string[];
  vehicleName?: string;
  vehicleYear?: string;
  propertyType?: string;
  maxGuests?: number;
  bedrooms?: number;
  bathrooms?: number;
  isActive: boolean;
  bookingMode: BookingMode;
  bookingRules: Partial<BookingRules>;
  /** Host-set flat percent discount (0–90). 0 = no discount. */
  discountPercent?: number;
  metadata?: Record<string, any>;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

// ============ Bookings ============

export type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';

export interface Booking {
  id: UUID;
  userId: UUID;
  providerId: UUID;
  providerUserId?: UUID;
  serviceCategory: string;
  listingId?: UUID;
  listingName?: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  status: BookingStatus;
  address?: string;
  /** WS6: false = host provided no street-level address (city-only). */
  hasExactAddress?: boolean;
  lat?: number;
  lng?: number;
  notes?: string;
  estimatedTravelMinutes?: number;
  providerName?: string;
  guestName?: string;
  /** Guest's phone for partner-side (host/provider/driver) booking details —
   *  the walk-up guest's contact on host-on-behalf bookings, else the guest's
   *  profile phone. Only populated on partner-facing queries. */
  guestPhone?: string;
  /** True when a host created this booking for a walk-up guest (paid via
   *  payment link). While pending it means "awaiting the guest's payment" —
   *  partner dashboards must not offer Accept/Decline on it. */
  bookedOnBehalf?: boolean;
  agreedPricePaise?: number;
  /** True total paid by the customer in paise — sum of base + platform fee
   *  + taxes + insurance − discount, derived from the completed payment
   *  row. `agreedPricePaise` only covers the host portion, so dashboards
   *  that need the full ticket value (My Bookings card, details modal)
   *  should prefer this when present. Undefined for unpaid / legacy
   *  bookings. */
  totalPaidPaise?: number;
  roomTypeId?: UUID;
  roomTypeName?: string;
  /** How many physical rooms of `roomTypeName` are on this single booking
   *  (e.g. 3 "Non-AC" rooms in one sathram booking). Defaults to 1. */
  roomCount?: number;
  /** Transport-only snapshots taken at booking time so the booking detail /
   *  summary keeps showing the booked vehicle + a way to reach the driver,
   *  even if the host later edits or removes the listing. Driver NAME reuses
   *  `providerName`. Undefined for non-transport / legacy bookings. */
  vehicleModel?: string;
  vehiclePlate?: string;
  vehicleColor?: string;
  driverPhone?: string;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export type QueueStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

export interface BookingQueueEntry {
  id: UUID;
  userId: UUID;
  providerId: UUID;
  serviceCategory: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  queuePosition: number;
  queueStatus: QueueStatus;
  confirmedBookingId?: UUID;
  rejectionReason?: string;
  requestedAt: ISOTimestamp;
  resolvedAt?: ISOTimestamp;
}

export interface SlotLock {
  id: UUID;
  providerId: UUID;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  lockedBy: UUID;
  expiresAt: ISOTimestamp;
}

// ============ Payments ============

export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';

export interface Payment {
  id: UUID;
  bookingId: UUID;
  userId: UUID;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  providerRef?: string; // external payment gateway reference
  metadata?: Record<string, any>;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

export interface PayoutRecord {
  id: UUID;
  providerId: UUID;
  bookingId: UUID;
  amount: number;
  currency: Currency;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  providerRef?: string;
  createdAt: ISOTimestamp;
}

// ============ Reviews ============

export interface Review {
  id: UUID;
  userId: UUID;
  stayId: string;
  rating: number;
  reviewText: string;
  displayName: string;
  tags: string[];
  helpfulCount: number;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

// ============ Insurance & Guarantees ============

export interface InsurancePolicy {
  id: UUID;
  bookingId: UUID;
  userId: UUID;
  premiumAmount: number;
  coverageAmount: number;
  coverageType: string;
  status: 'active' | 'claimed' | 'expired' | 'cancelled';
  createdAt: ISOTimestamp;
}

export interface InsuranceClaim {
  id: UUID;
  policyId: UUID;
  userId: UUID;
  claimAmount: number;
  description: string;
  evidenceUrl?: string;
  status: 'pending' | 'reviewing' | 'approved' | 'rejected';
  resolution?: string;
  resolvedAt?: ISOTimestamp;
  createdAt: ISOTimestamp;
}

export interface ServiceGuarantee {
  id: UUID;
  bookingId: UUID;
  providerId: UUID;
  userId: UUID;
  serviceCategory: string;
  guaranteeMonths: number;
  guaranteeLabel: string;
  startsAt: ISOTimestamp;
  expiresAt: ISOTimestamp;
  claimDescription?: string;
  claimStatus: 'none' | 'pending' | 'approved' | 'rejected';
  createdAt: ISOTimestamp;
}

// ============ Verification ============

export type DocumentStatus = 'pending' | 'reviewing' | 'approved' | 'rejected';

export interface VerificationDocument {
  id: UUID;
  userId: UUID;
  documentType: string;
  documentNumber?: string;
  fileUrl: string;
  status: DocumentStatus;
  rejectionReason?: string;
  reviewedAt?: ISOTimestamp;
  createdAt: ISOTimestamp;
}

// ============ Communication ============

export interface Message {
  id: UUID;
  senderId: UUID;
  receiverId: UUID;
  content: string;
  isRead: boolean;
  // Future: attachments, messageType, bookingRef
  createdAt: ISOTimestamp;
}

export interface Conversation {
  participantId: UUID;
  participantName: string;
  lastMessage: string;
  lastMessageAt: ISOTimestamp;
  unreadCount: number;
}

// ============ Notifications ============

export type NotificationType = 'system' | 'booking' | 'message' | 'review' | 'safety' | 'payment' | 'verification';

export interface Notification {
  id: UUID;
  userId: UUID;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  isRead: boolean;
  metadata?: Record<string, any>;
  createdAt: ISOTimestamp;
}

// ============ Safety ============

export interface SafetyAlert {
  id: UUID;
  userId: UUID;
  bookingId?: UUID;
  alertType: string;
  description?: string;
  locationLat?: number;
  locationLng?: number;
  status: 'open' | 'responding' | 'resolved';
  emergencyContactsNotified: boolean;
  resolvedAt?: ISOTimestamp;
  createdAt: ISOTimestamp;
}

// ============ Fraud / Risk ============

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FraudEvent {
  id: UUID;
  userId?: UUID;
  eventType: string;
  riskLevel: RiskLevel;
  metadata: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  createdAt: ISOTimestamp;
}

// ============ Audit ============

export interface AuditLogEntry {
  id: UUID;
  userId?: UUID;
  action: string;
  resource: string;
  resourceId?: UUID;
  metadata?: Record<string, any>;
  ipAddress?: string;
  createdAt: ISOTimestamp;
}

// ============ Legal / Consent ============

export interface ConsentRecord {
  id: UUID;
  userId: UUID;
  consentType: 'terms' | 'privacy' | 'marketing' | 'data_processing';
  version: string;
  acceptedAt: ISOTimestamp;
  revokedAt?: ISOTimestamp;
}

// ============ Pricing ============

export type DemandLevel = 'low' | 'normal' | 'high' | 'surge';

export interface PricingConfig {
  id: UUID;
  serviceCategory: string;
  minPrice: number;
  maxPrice?: number;
  isPremium: boolean;
  demandMultipliers: Record<DemandLevel, number>;
}

// ============ Provider Availability ============

export interface ProviderAvailability {
  id: UUID;
  providerId: UUID;
  dayOfWeek: number; // 0-6
  startTime: string;
  endTime: string;
  isActive: boolean;
}

// ============ Service Categories ============

export interface ServiceCategoryMetric {
  id: UUID;
  categoryName: string;
  subcategory?: string;
  supplyCount: number;
  demandScore: number;
  promotionPriority: number;
  isFeatured: boolean;
  isHomepageVisible: boolean;
  highDemandVertical: boolean;
  searchBoostFactor: number;
  tags: string[];
}
