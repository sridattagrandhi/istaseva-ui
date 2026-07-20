/**
 * Frontend Provider Registry
 *
 * The frontend now keeps only UI/runtime providers that truly need client-side
 * polymorphism. Data/storage/payment/search/KYC/LLM integrations are routed
 * through backend APIs and domain services instead.
 */

import { env } from "./environment";

import type { IAuthProvider } from "@/providers/auth/auth.interface";
import type { IRealtimeProvider } from "@/providers/realtime/realtime.interface";
import type { IAnalyticsProvider } from "@/providers/analytics/analytics.interface";

import { FirebaseAuthProvider } from "@/providers/auth/firebase-auth.provider";
import { WebSocketRealtimeProvider } from "@/providers/realtime/websocket-realtime.provider";
import { MixpanelAnalyticsProvider } from "@/providers/analytics/mixpanel-analytics.provider";
import { MockAnalyticsProvider } from "@/providers/analytics/mock-analytics.provider";

let authProvider: IAuthProvider | null = null;
let realtimeProvider: IRealtimeProvider | null = null;
let analyticsProvider: IAnalyticsProvider | null = null;

export function getAuthProvider(): IAuthProvider {
  if (!authProvider) {
    authProvider = new FirebaseAuthProvider();
  }
  return authProvider;
}

export function getRealtimeProvider(): IRealtimeProvider {
  if (!realtimeProvider) {
    switch (env.realtime.provider) {
      case "websocket":
        realtimeProvider = new WebSocketRealtimeProvider();
        break;
      default:
        realtimeProvider = new WebSocketRealtimeProvider();
    }
  }
  return realtimeProvider;
}

export function getAnalyticsProvider(): IAnalyticsProvider {
  if (!analyticsProvider) {
    switch (env.analytics.provider) {
      case "mixpanel":
        analyticsProvider = new MixpanelAnalyticsProvider();
        break;
      case "mock":
      default:
        analyticsProvider = new MockAnalyticsProvider();
    }
  }
  return analyticsProvider;
}
