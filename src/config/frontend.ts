import { z } from "zod";

const viteEnvSchema = z.object({
  VITE_APP_URL: z.string().url().optional(),
  VITE_ENVIRONMENT: z.enum(["development", "staging", "production"]).optional(),
  VITE_API_URL: z.string().url().optional(),
  VITE_AUTH_PROVIDER: z.enum(["firebase", "custom"]).optional(),
  VITE_DATABASE_PROVIDER: z.enum(["postgres", "custom"]).optional(),
  VITE_STORAGE_PROVIDER: z.enum(["s3", "custom"]).optional(),
  VITE_REALTIME_PROVIDER: z.enum(["websocket", "custom"]).optional(),
  VITE_PAYMENT_PROVIDER: z.enum(["mock", "razorpay", "stripe", "custom"]).optional(),
  VITE_NOTIFICATION_PROVIDER: z.enum(["mock", "sns", "firebase", "custom"]).optional(),
  VITE_SEARCH_PROVIDER: z.enum(["local", "opensearch", "algolia", "custom"]).optional(),
  VITE_KYC_PROVIDER: z.enum(["mock", "digilocker", "aadhaar", "custom"]).optional(),
  VITE_AI_PROVIDER: z.enum(["lovable", "gemini", "openai", "anthropic", "bedrock", "custom"]).optional(),
  VITE_ANALYTICS_PROVIDER: z.enum(["mock", "mixpanel", "custom"]).optional(),
  VITE_FIREBASE_API_KEY: z.string().optional(),
  VITE_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  VITE_FIREBASE_PROJECT_ID: z.string().optional(),
  VITE_FIREBASE_APP_ID: z.string().optional(),
  VITE_FIREBASE_MESSAGING_SENDER_ID: z.string().optional(),
  VITE_FIREBASE_STORAGE_BUCKET: z.string().optional(),
  VITE_FIREBASE_VAPID_KEY: z.string().optional(),
  VITE_AWS_REGION: z.string().optional(),
  VITE_WS_URL: z.string().optional(),
  VITE_MIXPANEL_TOKEN: z.string().optional(),
  VITE_RAZORPAY_KEY_ID: z.string().optional(),
  VITE_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  VITE_S3_BUCKET: z.string().optional(),
  VITE_OPENSEARCH_ENDPOINT: z.string().url().optional(),
  VITE_AI_MODEL: z.string().optional(),
});

const parsed = viteEnvSchema.safeParse(import.meta.env);

if (!parsed.success) {
  throw new Error(
    `Invalid frontend environment configuration:\n${parsed.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n")}`
  );
}

const values = parsed.data;

if (values.VITE_AUTH_PROVIDER === "firebase") {
  if (!values.VITE_FIREBASE_API_KEY || !values.VITE_FIREBASE_AUTH_DOMAIN || !values.VITE_FIREBASE_PROJECT_ID) {
    throw new Error("VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, and VITE_FIREBASE_PROJECT_ID are required when VITE_AUTH_PROVIDER=firebase");
  }
}

if (values.VITE_REALTIME_PROVIDER === "websocket" && !values.VITE_WS_URL) {
  throw new Error("VITE_WS_URL is required when VITE_REALTIME_PROVIDER=websocket");
}

if (values.VITE_ANALYTICS_PROVIDER === "mixpanel" && !values.VITE_MIXPANEL_TOKEN) {
  throw new Error("VITE_MIXPANEL_TOKEN is required when VITE_ANALYTICS_PROVIDER=mixpanel");
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested);
    }
  }
  return value;
}

const _apiUrl = values.VITE_API_URL || "http://localhost:3001";

export const frontendConfig = freezeDeep({
  appUrl: values.VITE_APP_URL || window.location.origin,
  environment: values.VITE_ENVIRONMENT || "development",
  apiUrl: _apiUrl,
  authProvider: values.VITE_AUTH_PROVIDER || "firebase",
  databaseProvider: values.VITE_DATABASE_PROVIDER || "postgres",
  storageProvider: values.VITE_STORAGE_PROVIDER || "s3",
  realtimeProvider: values.VITE_REALTIME_PROVIDER || "websocket",
  paymentProvider: values.VITE_PAYMENT_PROVIDER || "mock",
  notificationProvider: values.VITE_NOTIFICATION_PROVIDER || "mock",
  searchProvider: values.VITE_SEARCH_PROVIDER || "local",
  kycProvider: values.VITE_KYC_PROVIDER || "mock",
  aiProvider: values.VITE_AI_PROVIDER || "lovable",
  analyticsProvider: values.VITE_ANALYTICS_PROVIDER || "mock",
  awsRegion: values.VITE_AWS_REGION || "ap-south-1",
  firebase: {
    apiKey: values.VITE_FIREBASE_API_KEY,
    authDomain: values.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: values.VITE_FIREBASE_PROJECT_ID,
    // appId + messagingSenderId are required by Firebase Installations
    // (which FCM getToken() depends on). Auth alone works without them,
    // but push notifications will throw "Missing App configuration value:
    // 'appId'" if we try to initialize messaging.
    appId: values.VITE_FIREBASE_APP_ID,
    messagingSenderId: values.VITE_FIREBASE_MESSAGING_SENDER_ID,
    storageBucket: values.VITE_FIREBASE_STORAGE_BUCKET,
    vapidKey: values.VITE_FIREBASE_VAPID_KEY,
  },
  realtime: {
    wsUrl: values.VITE_WS_URL || _apiUrl.replace(/^http/, "ws") + "/ws",
  },
  analytics: {
    mixpanelToken: values.VITE_MIXPANEL_TOKEN,
  },
  payments: {
    razorpayKeyId: values.VITE_RAZORPAY_KEY_ID,
    stripePublishableKey: values.VITE_STRIPE_PUBLISHABLE_KEY,
  },
  storage: {
    s3Bucket: values.VITE_S3_BUCKET,
  },
  search: {
    endpoint: values.VITE_OPENSEARCH_ENDPOINT,
  },
  ai: {
    model: values.VITE_AI_MODEL || "gemini-2.5-flash",
  },
} as const);

export type FrontendConfig = typeof frontendConfig;
