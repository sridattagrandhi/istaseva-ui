import { z } from 'zod';

export const frontendEnvSchema = z.object({
  VITE_APP_URL: z.string().url().optional(),
  VITE_ENVIRONMENT: z.enum(['development', 'staging', 'production']).optional(),
  VITE_API_URL: z.string().url().optional(),
  VITE_AUTH_PROVIDER: z.enum(['firebase', 'custom']).optional(),
  VITE_REALTIME_PROVIDER: z.enum(['websocket', 'custom']).optional(),
  VITE_ANALYTICS_PROVIDER: z.enum(['mock', 'mixpanel', 'custom']).optional(),
  VITE_FIREBASE_API_KEY: z.string().optional(),
  VITE_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  VITE_FIREBASE_PROJECT_ID: z.string().optional(),
  VITE_AWS_REGION: z.string().optional(),
  VITE_WS_URL: z.string().url().or(z.string().startsWith('ws://')).or(z.string().startsWith('wss://')).optional(),
  VITE_MIXPANEL_TOKEN: z.string().optional(),
  VITE_RAZORPAY_KEY_ID: z.string().optional(),
  VITE_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
