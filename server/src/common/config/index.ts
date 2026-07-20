import 'dotenv/config';
import util from 'node:util';
import { z } from 'zod';
import { appSchema } from './schemas/app.schema.js';
import { authSchema } from './schemas/auth.schema.js';
import { databaseSchema } from './schemas/database.schema.js';
import { cacheSchema } from './schemas/cache.schema.js';
import { storageSchema } from './schemas/storage.schema.js';
import { paymentSchema } from './schemas/payment.schema.js';
import { searchSchema } from './schemas/search.schema.js';
import { notificationSchema } from './schemas/notification.schema.js';
import { kycSchema } from './schemas/kyc.schema.js';
import { llmSchema } from './schemas/llm.schema.js';
import { speechSchema } from './schemas/speech.schema.js';
import { eventsSchema } from './schemas/events.schema.js';
import { translationSchema } from './schemas/translation.schema.js';
import { geocodingSchema } from './schemas/geocoding.schema.js';
import { rateLimitSchema } from './schemas/rate-limit.schema.js';
import { analyticsVendorSchema } from './schemas/analytics-vendor.schema.js';

const rawEnv = { ...process.env };

const rootSchema = z.object({
  app: appSchema,
  auth: authSchema,
  database: databaseSchema,
  cache: cacheSchema,
  storage: storageSchema,
  payment: paymentSchema,
  search: searchSchema,
  notification: notificationSchema,
  kyc: kycSchema,
  llm: llmSchema,
  speech: speechSchema,
  events: eventsSchema,
  translation: translationSchema,
  geocoding: geocodingSchema,
  rateLimit: rateLimitSchema,
  analyticsVendor: analyticsVendorSchema,
}).superRefine((value, ctx) => {
  // `app.environment` (APP_ENV) is the deployment-tier label; `nodeEnv` is the
  // Node runtime mode. Production always blocks mock payments. Staging used
  // to block them too, but the booking flow needs end-to-end QA before
  // Razorpay creds are live — so we now allow mock on staging when the
  // operator explicitly opts in via `PAYMENT_ALLOW_MOCK_IN_DEPLOY=true`.
  // Production is still hard-blocked below regardless of that flag.
  const isProduction = value.app.nodeEnv === 'production'
    || value.app.environment === 'production';
  const isStaging = value.app.environment === 'staging';
  const allowMockOverride = process.env.PAYMENT_ALLOW_MOCK_IN_DEPLOY === 'true';

  if (isProduction && value.payment.provider === 'mock') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payment', 'provider'],
      message: 'Mock payment provider is not allowed in production — set PAYMENT_PROVIDER=razorpay',
    });
  } else if (isStaging && value.payment.provider === 'mock' && !allowMockOverride) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payment', 'provider'],
      message: 'Mock payment provider on staging requires PAYMENT_ALLOW_MOCK_IN_DEPLOY=true (explicit opt-in for booking-flow QA).',
    });
  }

  // NOTE: staging intentionally runs NODE_ENV=development so mock providers stay
  // allowed for QA (production hard-blocks them). Dev-only shortcuts — permissive
  // CORS and verbose error bodies — are therefore gated on the deploy-tier flags
  // derived below (APP_ENV-based, `isDeployedTier`), NOT on NODE_ENV, so they
  // stay locked down on staging regardless of NODE_ENV. We deliberately do NOT
  // assert NODE_ENV here — doing so would break the intentional staging config.

  if (value.app.nodeEnv === 'production') {
    const mockProviders = [
      ['cache.provider', value.cache.provider],
      ['payment.provider', value.payment.provider],
      ['notification.provider', value.notification.provider],
      ['kyc.provider', value.kyc.provider],
      ['llm.provider', value.llm.provider],
      ['events.provider', value.events.provider],
    ].filter(([, provider]) => provider === 'mock');

    for (const [path] of mockProviders) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: path.split('.'),
        message: 'Mock providers are blocked in production',
      });
    }

    if (value.auth.jwt.secret.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'jwt', 'secret'],
        message: 'JWT_SECRET must be at least 32 characters in production',
      });
    }
  }

  // Only enforced when the JWT auth provider is actually active. The 34-char
  // placeholder slips the length gate above, and the DefaultAuthProvider reads
  // `role` straight from the JWT — so a publicly-known secret means forgeable
  // admin tokens. Firebase deployments (the default on staging/prod) don't use
  // this secret, so they're intentionally exempt to avoid a false boot failure.
  if (value.auth.provider === 'jwt' && (isProduction || isStaging)
      && value.auth.jwt.secret === 'dev-jwt-secret-change-in-production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth', 'jwt', 'secret'],
      message: 'JWT_SECRET is still the dev placeholder — set a strong, unique secret on staging/production.',
    });
  }

  if (value.auth.provider === 'firebase' && !value.auth.firebase.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['auth', 'firebase', 'projectId'], message: 'FIREBASE_PROJECT_ID is required when AUTH_PROVIDER=firebase' });
  }

  if (value.payment.provider === 'razorpay') {
    if (!value.payment.razorpay.keyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'razorpay', 'keyId'], message: 'RAZORPAY_KEY_ID is required when PAYMENT_PROVIDER=razorpay' });
    }
    if (!value.payment.razorpay.keySecret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'razorpay', 'keySecret'], message: 'RAZORPAY_KEY_SECRET is required when PAYMENT_PROVIDER=razorpay' });
    }
    // Webhook secret is required for any deployed environment using Razorpay.
    // Only the test runner is allowed to skip it.
    if (!value.payment.razorpay.webhookSecret && value.app.nodeEnv !== 'test') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'razorpay', 'webhookSecret'], message: 'RAZORPAY_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=razorpay' });
    }
  }

  if (value.payment.provider === 'stripe' && !value.payment.stripe.secretKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'stripe', 'secretKey'], message: 'STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe' });
  }

  if (value.kyc.provider === 'digilocker') {
    if (!value.kyc.digilockerClientId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kyc', 'digilockerClientId'], message: 'DIGILOCKER_CLIENT_ID is required when KYC_PROVIDER=digilocker' });
    }
    if (!value.kyc.digilockerClientSecret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kyc', 'digilockerClientSecret'], message: 'DIGILOCKER_CLIENT_SECRET is required when KYC_PROVIDER=digilocker' });
    }
    if (!value.kyc.digilockerRedirectUri) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kyc', 'digilockerRedirectUri'], message: 'DIGILOCKER_REDIRECT_URI is required when KYC_PROVIDER=digilocker' });
    }
  }

  if (value.llm.provider === 'openai' && !value.llm.openaiApiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llm', 'openaiApiKey'], message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai' });
  }

  if (value.llm.provider === 'anthropic' && !value.llm.anthropicApiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llm', 'anthropicApiKey'], message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic' });
  }

  // Gemini (text + Live voice) and Google TTS all authenticate with the same
  // Vertex service account — no per-service API keys. When LLM_PROVIDER=gemini
  // or TTS_PROVIDER=google, the SA JSON + project must be present.
  if (value.llm.provider === 'gemini') {
    if (!value.llm.vertexServiceAccountJson) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llm', 'vertexServiceAccountJson'], message: 'GEMINI_VERTEX_SA_JSON is required when LLM_PROVIDER=gemini' });
    }
    if (!value.llm.vertexProject) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llm', 'vertexProject'], message: 'GEMINI_VERTEX_PROJECT is required when LLM_PROVIDER=gemini' });
    }
  }

  if (value.speech.ttsProvider === 'google') {
    if (!value.llm.vertexServiceAccountJson || !value.llm.vertexProject) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['speech', 'ttsProvider'], message: 'TTS_PROVIDER=google requires GEMINI_VERTEX_SA_JSON + GEMINI_VERTEX_PROJECT (TTS reuses the Vertex SA)' });
    }
  }

  if (value.translation.provider === 'bhashini') {
    if (!value.translation.bhashiniUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['translation', 'bhashiniUserId'], message: 'BHASHINI_USER_ID is required when TRANSLATION_PROVIDER=bhashini' });
    }
    if (!value.translation.bhashiniApiKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['translation', 'bhashiniApiKey'], message: 'BHASHINI_API_KEY is required when TRANSLATION_PROVIDER=bhashini' });
    }
    if (!value.translation.bhashiniUdyatKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['translation', 'bhashiniUdyatKey'], message: 'BHASHINI_UDYAT_KEY is required when TRANSLATION_PROVIDER=bhashini' });
    }
  }

  if (value.geocoding.provider === 'google' && !value.geocoding.googleMapsApiKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['geocoding', 'googleMapsApiKey'], message: 'GOOGLE_MAPS_API_KEY is required when GEOCODING_PROVIDER=google' });
  }

  if (value.events.provider === 'dynamodb') {
    if (!value.events.auditEventsTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', 'auditEventsTable'], message: 'DYNAMODB_AUDIT_EVENTS_TABLE is required when EVENT_PROVIDER=dynamodb' });
    }
    if (!value.events.fraudSignalsTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', 'fraudSignalsTable'], message: 'DYNAMODB_FRAUD_SIGNALS_TABLE is required when EVENT_PROVIDER=dynamodb' });
    }
    if (!value.events.apiRequestLogsTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', 'apiRequestLogsTable'], message: 'DYNAMODB_API_REQUEST_LOGS_TABLE is required when EVENT_PROVIDER=dynamodb' });
    }
    if (!value.events.searchEventsTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', 'searchEventsTable'], message: 'DYNAMODB_SEARCH_EVENTS_TABLE is required when EVENT_PROVIDER=dynamodb' });
    }
    if (!value.events.analyticsEventsTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', 'analyticsEventsTable'], message: 'DYNAMODB_ANALYTICS_EVENTS_TABLE is required when EVENT_PROVIDER=dynamodb' });
    }
  }
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }
  }
  return value;
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactConfig);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
      const isSecret = /(secret|password|token|apikey|apikey|key)$/i.test(key) && !/keyId$/i.test(key);
      return [key, isSecret && nestedValue ? '[REDACTED]' : redactConfig(nestedValue)];
    })
  );
}

function formatZodErrors(error: z.ZodError) {
  return error.issues
    .map((issue) => `- ${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('\n');
}

const parsed = rootSchema.safeParse({
  app: {
    nodeEnv: rawEnv.NODE_ENV,
    environment: rawEnv.APP_ENV || rawEnv.NODE_ENV,
    port: rawEnv.PORT,
    apiUrl: rawEnv.API_URL,
    frontendUrl: rawEnv.FRONTEND_URL,
    logLevel: rawEnv.LOG_LEVEL,
    platformGstin: rawEnv.PLATFORM_GSTIN,
  },
  auth: {
    provider: rawEnv.AUTH_PROVIDER,
    firebase: {
      projectId: rawEnv.FIREBASE_PROJECT_ID,
      serviceAccountPath: rawEnv.FIREBASE_SERVICE_ACCOUNT_PATH,
      serviceAccountJson: rawEnv.FIREBASE_SERVICE_ACCOUNT_JSON,
    },
    jwt: {
      secret: rawEnv.JWT_SECRET,
    },
    passwordReset: {
      webPath: rawEnv.PASSWORD_RESET_WEB_PATH,
      mobileDeepLink: rawEnv.PASSWORD_RESET_MOBILE_DEEP_LINK,
      iosBundleId: rawEnv.PASSWORD_RESET_IOS_BUNDLE_ID,
      androidPackageName: rawEnv.PASSWORD_RESET_ANDROID_PACKAGE,
      dynamicLinkDomain: rawEnv.PASSWORD_RESET_DYNAMIC_LINK_DOMAIN,
    },
  },
  database: {
    provider: rawEnv.DATABASE_PROVIDER,
    // ECS injects individual DB_* fields from Secrets Manager rather than a full DATABASE_URL.
    // Construct the URL from parts when DATABASE_URL is absent.
    url: rawEnv.DATABASE_URL
      || (rawEnv.DB_HOST
          ? `postgres://${rawEnv.DB_USER}:${encodeURIComponent(rawEnv.DB_PASSWORD ?? '')}@${rawEnv.DB_HOST}:${rawEnv.DB_PORT ?? 5432}/${rawEnv.DB_NAME ?? 'instaserve'}`
          : 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve'),
    poolMin: rawEnv.DATABASE_POOL_MIN,
    poolMax: rawEnv.DATABASE_POOL_MAX,
  },
  cache: {
    provider: rawEnv.CACHE_PROVIDER,
    url: rawEnv.REDIS_URL,
    host: rawEnv.REDIS_HOST,
    port: rawEnv.REDIS_PORT,
    tls: rawEnv.REDIS_TLS,
    authToken: rawEnv.REDIS_AUTH_TOKEN,
    keyPrefix: rawEnv.REDIS_KEY_PREFIX,
    defaultTtlSeconds: rawEnv.CACHE_TTL_SECONDS,
    bookingHoldTtlSeconds: rawEnv.BOOKING_HOLD_TTL_SECONDS,
    idempotencyTtlSeconds: rawEnv.IDEMPOTENCY_TTL_SECONDS,
  },
  storage: {
    provider: rawEnv.STORAGE_PROVIDER,
    awsRegion: rawEnv.AWS_REGION,
    awsAccessKeyId: rawEnv.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: rawEnv.AWS_SECRET_ACCESS_KEY,
    endpoint: rawEnv.S3_ENDPOINT,
    forcePathStyle: rawEnv.S3_FORCE_PATH_STYLE,
    publicBaseUrl: rawEnv.S3_PUBLIC_BASE_URL,
    bucketUploads: rawEnv.S3_BUCKET_UPLOADS || 'instaserve-uploads',
    bucketVerification: rawEnv.S3_BUCKET_VERIFICATION || 'instaserve-verification-docs',
    bucketFrontend: rawEnv.S3_BUCKET_FRONTEND || 'instaserve-frontend',
    bucketClaims: rawEnv.S3_BUCKET_CLAIMS || rawEnv.S3_BUCKET_UPLOADS || 'instaserve-uploads',
    bucketChat: rawEnv.S3_BUCKET_CHAT || rawEnv.S3_BUCKET_UPLOADS || 'instaserve-uploads',
    bucketListings: rawEnv.S3_BUCKET_LISTINGS || rawEnv.S3_BUCKET_UPLOADS || 'instaserve-uploads',
    prefixListings: rawEnv.S3_PREFIX_LISTINGS,
    prefixClaims: rawEnv.S3_PREFIX_CLAIMS,
    prefixChat: rawEnv.S3_PREFIX_CHAT,
    prefixVerification: rawEnv.S3_PREFIX_VERIFICATION,
    presignedUploadExpirySeconds: rawEnv.S3_PRESIGNED_UPLOAD_EXPIRY_SECONDS,
    presignedDownloadExpirySeconds: rawEnv.S3_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
  },
  payment: {
    provider: rawEnv.PAYMENT_PROVIDER,
    defaultCurrency: rawEnv.PAYMENT_DEFAULT_CURRENCY,
    razorpay: {
      keyId: rawEnv.RAZORPAY_KEY_ID,
      keySecret: rawEnv.RAZORPAY_KEY_SECRET,
      webhookSecret: rawEnv.RAZORPAY_WEBHOOK_SECRET,
    },
    stripe: {
      secretKey: rawEnv.STRIPE_SECRET_KEY,
      webhookSecret: rawEnv.STRIPE_WEBHOOK_SECRET,
    },
  },
  search: {
    provider: rawEnv.SEARCH_PROVIDER,
  },
  notification: {
    provider: rawEnv.NOTIFICATION_PROVIDER,
    sesFromEmail: rawEnv.SES_FROM_EMAIL,
    snsSenderId: rawEnv.SNS_SMS_SENDER_ID,
    sqsQueueUrl: rawEnv.SQS_NOTIFICATION_QUEUE_URL,
    smtpHost: rawEnv.SMTP_HOST,
    smtpPort: rawEnv.SMTP_PORT,
    smtpUser: rawEnv.SMTP_USER,
    smtpPass: rawEnv.SMTP_PASS,
    smtpFromEmail: rawEnv.SMTP_FROM_EMAIL,
    smtpSecure: rawEnv.SMTP_SECURE,
  },
  kyc: {
    provider: rawEnv.KYC_PROVIDER,
    digilockerClientId: rawEnv.DIGILOCKER_CLIENT_ID,
    digilockerClientSecret: rawEnv.DIGILOCKER_CLIENT_SECRET,
    digilockerRedirectUri: rawEnv.DIGILOCKER_REDIRECT_URI,
  },
  llm: {
    provider: rawEnv.LLM_PROVIDER,
    model: rawEnv.LLM_MODEL,
    openaiApiKey: rawEnv.OPENAI_API_KEY,
    anthropicApiKey: rawEnv.ANTHROPIC_API_KEY,
    // All Gemini calls (text + Live voice) route through Vertex AI using
    // this service account. The per-service API-key path was removed to
    // keep exactly one Google credential in the app.
    vertexProject: rawEnv.GEMINI_VERTEX_PROJECT,
    vertexLocation: rawEnv.GEMINI_VERTEX_LOCATION,
    vertexServiceAccountJson: rawEnv.GEMINI_VERTEX_SA_JSON,
    assistantToolLoopEnabled: rawEnv.ASSISTANT_TOOL_LOOP,
    assistantMaxToolTurns: rawEnv.ASSISTANT_MAX_TOOL_TURNS,
    onboardingAgentEnabled: rawEnv.ONBOARDING_AGENT,
    assistantMemoryEnabled: rawEnv.ASSISTANT_MEMORY,
    assistantGroundingEnabled: rawEnv.ASSISTANT_GROUNDING,
    assistantSpeculativeEnabled: rawEnv.ASSISTANT_SPECULATIVE,
    assistantChipsEnabled: rawEnv.ASSISTANT_CHIPS,
    assistantSupportUserId: rawEnv.ASSISTANT_SUPPORT_USER_ID,
  },
  speech: {
    ttsProvider: rawEnv.TTS_PROVIDER,
    // Google Cloud TTS reuses the Vertex SA (see tts.service.ts) — no
    // separate credential needed.
    googleVoiceModel: rawEnv.GOOGLE_TTS_VOICE_MODEL,
  },
  events: {
    provider: rawEnv.EVENT_PROVIDER,
    endpoint: rawEnv.DYNAMODB_ENDPOINT,
    auditEventsTable: rawEnv.DYNAMODB_AUDIT_EVENTS_TABLE,
    fraudSignalsTable: rawEnv.DYNAMODB_FRAUD_SIGNALS_TABLE,
    apiRequestLogsTable: rawEnv.DYNAMODB_API_REQUEST_LOGS_TABLE,
    searchEventsTable: rawEnv.DYNAMODB_SEARCH_EVENTS_TABLE,
    analyticsEventsTable: rawEnv.DYNAMODB_ANALYTICS_EVENTS_TABLE,
    communicationLogsTable: rawEnv.DYNAMODB_COMMUNICATION_LOGS_TABLE,
    recommendationSignalsTable: rawEnv.DYNAMODB_RECOMMENDATION_SIGNALS_TABLE,
  },
  translation: {
    provider: rawEnv.TRANSLATION_PROVIDER,
    bhashiniUserId: rawEnv.BHASHINI_USER_ID,
    bhashiniApiKey: rawEnv.BHASHINI_API_KEY,
    bhashiniUdyatKey: rawEnv.BHASHINI_UDYAT_KEY,
    bhashiniPipelineEndpoint: rawEnv.BHASHINI_PIPELINE_ENDPOINT,
    bhashiniPipelineId: rawEnv.BHASHINI_PIPELINE_ID,
  },
  geocoding: {
    provider: rawEnv.GEOCODING_PROVIDER,
    googleMapsApiKey: rawEnv.GOOGLE_MAPS_API_KEY,
  },
  analyticsVendor: {
    mixpanelProjectToken: rawEnv.MIXPANEL_PROJECT_TOKEN,
    mixpanelGdprToken: rawEnv.MIXPANEL_GDPR_TOKEN,
  },
  rateLimit: {
    api:       { windowMs: rawEnv.RATE_LIMIT_API_WINDOW_MS,       max: rawEnv.RATE_LIMIT_API_MAX },
    auth:      { windowMs: rawEnv.RATE_LIMIT_AUTH_WINDOW_MS,      max: rawEnv.RATE_LIMIT_AUTH_MAX },
    messages:  { windowMs: rawEnv.RATE_LIMIT_MESSAGES_WINDOW_MS,  max: rawEnv.RATE_LIMIT_MESSAGES_MAX },
    bookings:  { windowMs: rawEnv.RATE_LIMIT_BOOKINGS_WINDOW_MS,  max: rawEnv.RATE_LIMIT_BOOKINGS_MAX },
    reviews:   { windowMs: rawEnv.RATE_LIMIT_REVIEWS_WINDOW_MS,   max: rawEnv.RATE_LIMIT_REVIEWS_MAX },
    search:    { windowMs: rawEnv.RATE_LIMIT_SEARCH_WINDOW_MS,    max: rawEnv.RATE_LIMIT_SEARCH_MAX },
    payments:  { windowMs: rawEnv.RATE_LIMIT_PAYMENTS_WINDOW_MS,  max: rawEnv.RATE_LIMIT_PAYMENTS_MAX },
    llm:       { windowMs: rawEnv.RATE_LIMIT_LLM_WINDOW_MS,       max: rawEnv.RATE_LIMIT_LLM_MAX },
    uploads:   { windowMs: rawEnv.RATE_LIMIT_UPLOADS_WINDOW_MS,   max: rawEnv.RATE_LIMIT_UPLOADS_MAX },
    listings:  { windowMs: rawEnv.RATE_LIMIT_LISTINGS_WINDOW_MS,  max: rawEnv.RATE_LIMIT_LISTINGS_MAX },
    coupons:   { windowMs: rawEnv.RATE_LIMIT_COUPONS_WINDOW_MS,   max: rawEnv.RATE_LIMIT_COUPONS_MAX },
  },
});

if (!parsed.success) {
  throw new Error(`Invalid environment configuration:\n${formatZodErrors(parsed.error)}`);
}

const baseConfig = parsed.data;

// Deployed tiers (staging/production, or NODE_ENV=production) never get the
// dev-only conveniences. Both were previously gated on NODE_ENV alone, which is
// unsafe because the committed .env sets NODE_ENV=development.
const isDeployedTier =
  baseConfig.app.nodeEnv === 'production' ||
  baseConfig.app.environment === 'staging' ||
  baseConfig.app.environment === 'production';
// Reflect any Origin with credentials — explicit opt-in for LAN/tunnel dev only,
// and hard-off on any deployed tier regardless of the flag.
const corsAllowAll = process.env.CORS_ALLOW_ALL === 'true' && !isDeployedTier;
// Return raw error messages to clients — never on a deployed tier.
const exposeErrors = !isDeployedTier;

const configValue = {
  app: { ...baseConfig.app, corsAllowAll, exposeErrors },
  auth: baseConfig.auth,
  database: baseConfig.database,
  cache: baseConfig.cache,
  storage: baseConfig.storage,
  payment: baseConfig.payment,
  search: baseConfig.search,
  notification: baseConfig.notification,
  kyc: baseConfig.kyc,
  llm: baseConfig.llm,
  speech: baseConfig.speech,
  events: baseConfig.events,
  translation: baseConfig.translation,
  geocoding: baseConfig.geocoding,
  rateLimit: baseConfig.rateLimit,
  analyticsVendor: baseConfig.analyticsVendor,
  aws: {
    region: baseConfig.storage.awsRegion,
    accessKeyId: baseConfig.storage.awsAccessKeyId,
    secretAccessKey: baseConfig.storage.awsSecretAccessKey,
  },
} as const;

export type AppConfig = typeof configValue;

export const config: AppConfig = deepFreeze(
  Object.assign(configValue, {
    toJSON: () => redactConfig(configValue),
    toString: () => JSON.stringify(redactConfig(configValue), null, 2),
    [util.inspect.custom]: () => redactConfig(configValue),
  })
);

export const redactedConfig = () => redactConfig(config);
