import { config } from '../config/index.js';
import type { IAuthProvider } from './interfaces/auth-provider.interface.js';
import type { IDatabaseProvider } from './interfaces/database-provider.interface.js';
import type { ICacheProvider } from './interfaces/cache-provider.interface.js';
import type { IStorageProvider } from './interfaces/storage-provider.interface.js';
import type { IPaymentProvider } from './interfaces/payment-provider.interface.js';
import type { INotificationProvider } from './interfaces/notification-provider.interface.js';
import type { IRealtimeProvider } from './interfaces/realtime-provider.interface.js';
import type { ISearchProvider } from './interfaces/search-provider.interface.js';
import type { IKycProvider } from './interfaces/kyc-provider.interface.js';
import type { ILlmProvider } from './interfaces/llm-provider.interface.js';
import type { IEventProvider } from './interfaces/event-provider.interface.js';

let authProviderPromise: Promise<IAuthProvider> | null = null;
let databaseProviderPromise: Promise<IDatabaseProvider> | null = null;
let cacheProviderPromise: Promise<ICacheProvider> | null = null;
let storageProviderPromise: Promise<IStorageProvider> | null = null;
let paymentProviderPromise: Promise<IPaymentProvider> | null = null;
let notificationProviderPromise: Promise<INotificationProvider> | null = null;
let realtimeProviderPromise: Promise<IRealtimeProvider> | null = null;
let searchProviderPromise: Promise<ISearchProvider> | null = null;
let kycProviderPromise: Promise<IKycProvider> | null = null;
let llmProviderPromise: Promise<ILlmProvider> | null = null;
let eventProviderPromise: Promise<IEventProvider> | null = null;

export async function getAuthProvider(): Promise<IAuthProvider> {
  const provider = config.auth.provider;
  if (!authProviderPromise) {
    switch (provider) {
      case 'firebase':
        authProviderPromise = import('./implementations/auth/firebase-auth.provider.js').then(({ firebaseAuthProvider }) => firebaseAuthProvider);
        break;
      case 'jwt':
      default:
        authProviderPromise = import('./implementations/auth/default-auth.provider.js').then(({ defaultAuthProvider }) => defaultAuthProvider);
        break;
    }
  }
  return authProviderPromise;
}

export async function getDatabaseProvider(): Promise<IDatabaseProvider> {
  const provider = config.database.provider;
  if (!databaseProviderPromise) {
    switch (provider) {
      case 'postgres':
        databaseProviderPromise = import('./implementations/database/postgres-database.provider.js').then(({ postgresDatabaseProvider }) => postgresDatabaseProvider);
        break;
      default:
        throw new Error(`Unsupported database provider: ${provider}`);
    }
  }
  return await databaseProviderPromise;
}

export async function getCacheProvider(): Promise<ICacheProvider> {
  const provider = config.cache.provider;
  if (!cacheProviderPromise) {
    switch (provider) {
      case 'redis':
        cacheProviderPromise = import('./implementations/cache/redis-cache.provider.js').then(({ redisCacheProvider }) => redisCacheProvider);
        break;
      case 'mock':
        cacheProviderPromise = import('./implementations/cache/mock-cache.provider.js').then(({ mockCacheProvider }) => mockCacheProvider);
        break;
      default:
        throw new Error(`Unsupported cache provider: ${provider}`);
    }
  }
  return cacheProviderPromise;
}

export async function getStorageProvider(): Promise<IStorageProvider> {
  const provider = config.storage.provider;
  if (!storageProviderPromise) {
    switch (provider) {
      case 's3':
        storageProviderPromise = import('./implementations/storage/s3-storage.provider.js').then(({ s3StorageProvider }) => s3StorageProvider);
        break;
      case 'local':
        storageProviderPromise = import('./implementations/storage/local-storage.provider.js').then(({ localStorageProvider }) => localStorageProvider);
        break;
      default:
        throw new Error(`Unsupported storage provider: ${provider}`);
    }
  }
  return await storageProviderPromise;
}

export async function getPaymentProvider(): Promise<IPaymentProvider> {
  const provider = config.payment.provider;
  if (!paymentProviderPromise) {
    switch (provider) {
      case 'razorpay':
        paymentProviderPromise = import('../../modules/payments/adapters/razorpay.adapter.js').then(({ razorpayAdapter }) => razorpayAdapter);
        break;
      case 'mock':
        paymentProviderPromise = import('./implementations/payment/mock-payment.provider.js').then(({ mockPaymentProvider }) => mockPaymentProvider);
        break;
      default:
        throw new Error(`Unsupported payment provider: ${provider}`);
    }
  }
  return paymentProviderPromise;
}

export async function getNotificationProvider(): Promise<INotificationProvider> {
  const provider = config.notification.provider;
  notificationProviderPromise ??= provider === 'default'
    ? import('../../modules/notifications/adapters/notification-channels.adapter.js').then(({ notificationChannelsAdapter }) => notificationChannelsAdapter)
    : import('../../modules/notifications/adapters/notification-channels.adapter.js').then(({ notificationChannelsAdapter }) => notificationChannelsAdapter);
  return notificationProviderPromise;
}

export async function getRealtimeProvider(): Promise<IRealtimeProvider> {
  realtimeProviderPromise ??= import('./implementations/realtime/noop-realtime.provider.js').then(({ noopRealtimeProvider }) => noopRealtimeProvider);
  return realtimeProviderPromise;
}

export async function getSearchProvider(): Promise<ISearchProvider> {
  searchProviderPromise ??= import('./implementations/search/postgres-search.provider.js')
    .then(({ postgresSearchProvider }) => postgresSearchProvider);
  return searchProviderPromise;
}

export async function getKycProvider(): Promise<IKycProvider> {
  const provider = config.kyc.provider;
  kycProviderPromise ??= provider === 'mock'
    ? import('./implementations/kyc/mock-kyc.provider.js').then(({ mockKycProvider }) => mockKycProvider)
    : import('./implementations/kyc/mock-kyc.provider.js').then(({ mockKycProvider }) => mockKycProvider);
  return kycProviderPromise;
}

export async function getLlmProvider(): Promise<ILlmProvider> {
  const provider = config.llm.provider;
  if (!llmProviderPromise) {
    switch (provider) {
      case 'gemini':
        llmProviderPromise = import('./implementations/llm/gemini-llm.provider.js').then(({ geminiLlmProvider }) => geminiLlmProvider);
        break;
      case 'openai':
      case 'anthropic':
      case 'bedrock':
        llmProviderPromise = import('./implementations/llm/default-llm.provider.js').then(({ defaultLlmProvider }) => defaultLlmProvider);
        break;
      default:
        llmProviderPromise = import('./implementations/llm/mock-llm.provider.js').then(({ mockLlmProvider }) => mockLlmProvider);
        break;
    }
  }
  return llmProviderPromise;
}

export async function getEventProvider(): Promise<IEventProvider> {
  const provider = config.events.provider;

  if (!eventProviderPromise) {
    eventProviderPromise = provider === 'dynamodb'
      ? import('./implementations/events/dynamodb-event.provider.js').then(({ dynamoDbEventProvider }) => dynamoDbEventProvider)
      : import('./implementations/events/mock-event.provider.js').then(({ mockEventProvider }) => mockEventProvider);
  }

  return eventProviderPromise;
}
