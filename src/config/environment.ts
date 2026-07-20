import { frontendConfig } from "./frontend";

/**
 * Environment Configuration
 *
 * Centralized frontend runtime configuration derived from validated `VITE_` vars.
 */

export interface EnvironmentConfig {
  appName: string;
  appUrl: string;
  environment: "development" | "staging" | "production";
  auth: {
    provider: "firebase" | "custom";
    firebaseApiKey?: string;
    firebaseAuthDomain?: string;
    firebaseProjectId?: string;
  };
  database: {
    provider: "postgres" | "custom";
    postgresUrl?: string;
  };
  storage: {
    provider: "s3" | "custom";
    bucket?: string;
    s3Region?: string;
    s3Bucket?: string;
  };
  realtime: {
    provider: "websocket" | "pusher" | "custom";
    wsUrl?: string;
  };
  payment: {
    provider: "mock" | "stripe" | "razorpay" | "custom";
    publicKey?: string;
  };
  notifications: {
    provider: "mock" | "firebase" | "sns" | "custom";
  };
  search: {
    provider: "local" | "opensearch" | "algolia" | "custom";
    endpoint?: string;
  };
  kyc: {
    provider: "mock" | "digilocker" | "aadhaar" | "custom";
  };
  ai: {
    provider: "lovable" | "gemini" | "openai" | "anthropic" | "bedrock" | "custom";
    model?: string;
  };
  analytics: {
    provider: "mock" | "mixpanel" | "amplitude" | "custom";
  };
  features: Record<string, boolean>;
}

export const env: EnvironmentConfig = {
  appName: "IstaSeva",
  appUrl: frontendConfig.appUrl,
  environment: frontendConfig.environment as EnvironmentConfig["environment"],
  auth: {
    provider: frontendConfig.authProvider as EnvironmentConfig["auth"]["provider"],
    firebaseApiKey: frontendConfig.firebase.apiKey,
    firebaseAuthDomain: frontendConfig.firebase.authDomain,
    firebaseProjectId: frontendConfig.firebase.projectId,
  },
  database: {
    provider: frontendConfig.databaseProvider as EnvironmentConfig["database"]["provider"],
    postgresUrl: frontendConfig.apiUrl,
  },
  storage: {
    provider: frontendConfig.storageProvider as EnvironmentConfig["storage"]["provider"],
    bucket: "verification-documents",
    s3Region: frontendConfig.awsRegion,
    s3Bucket: frontendConfig.storage.s3Bucket,
  },
  realtime: {
    provider: frontendConfig.realtimeProvider as EnvironmentConfig["realtime"]["provider"],
    wsUrl: frontendConfig.realtime.wsUrl,
  },
  payment: {
    provider: frontendConfig.paymentProvider as EnvironmentConfig["payment"]["provider"],
    publicKey: frontendConfig.payments.razorpayKeyId || frontendConfig.payments.stripePublishableKey,
  },
  notifications: {
    provider: frontendConfig.notificationProvider as EnvironmentConfig["notifications"]["provider"],
  },
  search: {
    provider: frontendConfig.searchProvider as EnvironmentConfig["search"]["provider"],
    endpoint: frontendConfig.search.endpoint,
  },
  kyc: {
    provider: frontendConfig.kycProvider as EnvironmentConfig["kyc"]["provider"],
  },
  ai: {
    provider: frontendConfig.aiProvider as EnvironmentConfig["ai"]["provider"],
    model: frontendConfig.ai.model,
  },
  analytics: {
    provider: frontendConfig.analyticsProvider as EnvironmentConfig["analytics"]["provider"],
  },
  features: {
    enableInsurance: true,
    enableServiceGuarantees: true,
    enableSmartScheduling: true,
    enableRealtimeChat: true,
    enableAIOnboarding: true,
    enableSafetyAlerts: true,
    enableProviderVerification: true,
    enableFraudDetection: false,
    enableAuditLog: true,
    enableLegalConsent: true,
    enableSupplyOptimization: true,
  },
};

export function isFeatureEnabled(flag: string): boolean {
  return env.features[flag] ?? false;
}
