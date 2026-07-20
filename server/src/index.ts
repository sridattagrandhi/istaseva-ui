import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from './common/config/index.js';
import { connectRedis, redis, tryAcquireSchedulerLease } from './common/cache/redis.js';
import { pool } from './common/db/postgres.js';
import { logger } from './common/logging/logger.js';
import { getLlmProvider } from './common/providers/registry.js';
import { createApp } from './app/create-app.js';
import { bookingsService } from './modules/bookings/index.js';
import { wsRealtimeProvider } from './common/providers/implementations/realtime/ws-realtime.provider.js';
import { notificationWorker } from './modules/notifications/services/notification-worker.service.js';
import { supplyOptimizationService } from './modules/analytics/services/supply-optimization.service.js';
import { analyticsRollupService } from './modules/analytics/services/analytics-rollup.service.js';
import { accountLifecycleService } from './modules/users/services/account-lifecycle.service.js';

const app = createApp();
const server = http.createServer(app);
// Keep-alive must outlive the ALB idle timeout (60s in staging/prod). Node's
// default keepAliveTimeout is 5s — shorter than the ALB's, so the ALB reuses a
// connection Node has already begun closing, and the race surfaces as sporadic
// ELB 502s under load (with zero target-connection errors). Setting both above
// 60s closes that window. headersTimeout must exceed keepAliveTimeout.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
let holdCleanupTimer: NodeJS.Timeout | null = null;
let supplyMetricsTimer: NodeJS.Timeout | null = null;
let accountLifecycleTimer: NodeJS.Timeout | null = null;
let analyticsRollupTimer: NodeJS.Timeout | null = null;
const MAX_PORT_FALLBACK_ATTEMPTS = 10;

// ── Server Start ──

function isAutoPortFallbackEnabled() {
  return config.app.nodeEnv !== 'production';
}

async function listenWithFallback(initialPort: number) {
  let attempt = 0;
  let port = initialPort;

  while (attempt < MAX_PORT_FALLBACK_ATTEMPTS) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(err);
        };

        const onListening = () => {
          server.off('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
      });

      return port;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const canRetry = error.code === 'EADDRINUSE' && isAutoPortFallbackEnabled();

      if (!canRetry) {
        if (error.code === 'EADDRINUSE') {
          logger.error('Server port is already in use', {
            port,
            hint: `Stop the process using port ${port} or set PORT to a different value before running the server`,
          });
        } else {
          logger.error('Server failed to start', { error: error.message });
        }
        process.exit(1);
      }

      attempt += 1;
      logger.warn('Server port is already in use, trying next port', {
        attemptedPort: port,
        nextPort: port + 1,
      });
      port += 1;
    }
  }

  logger.error('Unable to find an available port for the server', {
    startPort: initialPort,
    attempts: MAX_PORT_FALLBACK_ATTEMPTS,
  });
  process.exit(1);
}

async function start() {
  // Connect to Redis (non-blocking — app works without it)
  await connectRedis();

  // Verify database connection
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err: any) {
    logger.error('Database connection failed', { error: err.message });
    process.exit(1);
  }

  try {
    if (config.llm.provider === 'gemini') {
      await getLlmProvider();
    }
  } catch (err: any) {
    logger.error('Provider initialization failed', { error: err.message });
    process.exit(1);
  }

  // Wire the Gemini Live voice route before attach() so the provider knows
  // about it when the HTTP upgrade listener is installed. Only enable when
  // the Vertex SA is actually configured — otherwise /ws/voice cleanly 404s
  // instead of opening sessions that will fail at runtime.
  if (config.llm.vertexServiceAccountJson && config.llm.vertexProject) {
    const { runVoiceSession } = await import('./modules/chat/services/voice-live.service.js');
    wsRealtimeProvider.setVoiceHandler((ws, userId, displayName, query) => {
      const modeParam = query?.get('mode');
      const mode = modeParam === 'onboarding' ? 'onboarding' : 'sathi';
      // entryType only meaningful for onboarding. The frontend passes it
      // from the URL ?type= so the agent knows which doorway the user
      // walked through (host vs provider portal).
      const entryParam = query?.get('entry');
      const entryType: 'host' | 'service' | 'transport' | 'any' =
        entryParam === 'host' ? 'host' :
        entryParam === 'service' ? 'service' :
        entryParam === 'transport' ? 'transport' : 'any';
      // Onboarding can pass a base64-encoded profile JSON in the URL so the
      // voice agent's systemInstruction starts with "what we know so far"
      // and doesn't re-ask filled fields.
      let initialProfile: Record<string, unknown> | undefined;
      const profileParam = query?.get('profile');
      if (profileParam) {
        try {
          const json = Buffer.from(profileParam, 'base64').toString('utf-8');
          const parsed = JSON.parse(json);
          if (parsed && typeof parsed === 'object') initialProfile = parsed as Record<string, unknown>;
        } catch { /* ignore malformed */ }
      }
      void runVoiceSession({ clientWs: ws, userId, displayName, mode, entryType, initialProfile });
    });
    logger.info('Gemini Live voice route enabled at /ws/voice');
  } else {
    // Loud warning so an env-vars-missing situation isn't silent. The
    // onboarding voice tile + assistant voice button BOTH hit /ws/voice;
    // without this the only signal in prod was the client's generic
    // "connection error" with no server-side breadcrumb.
    logger.warn(
      'Voice route /ws/voice DISABLED — GEMINI_VERTEX_SA_JSON / GEMINI_VERTEX_PROJECT not set. '
      + 'Set these in Secrets Manager (instaserve/<env>/app) to enable Gemini Live voice.',
    );
  }

  // Attach WebSocket server for realtime messaging. Connection auth is
  // ticket-based (SEC-008): clients mint a single-use ticket via
  // POST /api/auth/ws-ticket and present it as ?ticket= on the upgrade —
  // bearer tokens never travel in the WS URL.
  wsRealtimeProvider.attach(server);

  const listeningPort = await listenWithFallback(config.app.port);
  const address = server.address() as AddressInfo | null;

  logger.info(`IstaSeva API server running`, {
    port: address?.port ?? listeningPort,
    env: config.app.nodeEnv,
    frontend: config.app.frontendUrl,
  });

  if (listeningPort !== config.app.port) {
    logger.warn('Server started on a fallback port', {
      configuredPort: config.app.port,
      activePort: listeningPort,
      hint: 'Update PORT and API_URL in your local env if you want clients to target this port by default',
    });
  }

  // ARC-003 / ENG-006: these timers fire in every ECS task. Wrap each run in a
  // fleet-wide Redis lease so only one task actually does the work per interval
  // (prod runs 2→10 tasks). The lease TTL is a shade under the interval so it
  // clears before the next tick and the next run re-elects a leader. All these
  // jobs are idempotent, and the lease fails open, so losing Redis just falls
  // back to the previous harmless N-way duplication.
  const leased = (name: string, intervalMs: number, run: () => Promise<void>) => async () => {
    if (!(await tryAcquireSchedulerLease(name, Math.floor(intervalMs * 0.9)))) return;
    await run();
  };

  const runHoldCleanup = leased('hold-cleanup', 60_000, async () => {
    try {
      await bookingsService.runExpiredHoldCleanup();
    } catch (err: any) {
      logger.warn('Expired hold cleanup failed', { error: err.message });
    }
  });
  holdCleanupTimer = setInterval(runHoldCleanup, 60_000);
  holdCleanupTimer.unref();

  // Recalculate service_category_metrics periodically. Without this, the
  // supply-optimization endpoint returns empty arrays until someone hits it
  // with ?recalculate=1. 15-minute cadence is plenty — this is aggregated,
  // not real-time. Leader election across tasks is handled by the `leased`
  // wrapper (ARC-003 / ENG-006); the UPSERTs remain idempotent as a backstop
  // for the fail-open case.
  const SUPPLY_METRICS_INTERVAL_MS = 15 * 60_000;
  const runSupplyMetrics = leased('supply-metrics', SUPPLY_METRICS_INTERVAL_MS, async () => {
    try {
      await supplyOptimizationService.recalculateMetrics();
    } catch (err: any) {
      logger.warn('Supply metrics recalculation failed', { error: err.message });
    }
  });
  void runSupplyMetrics(); // kick off once at boot so the table isn't empty
  supplyMetricsTimer = setInterval(runSupplyMetrics, SUPPLY_METRICS_INTERVAL_MS);
  supplyMetricsTimer.unref();

  // Roll up behavioural analytics (DynamoDB → Postgres). Rolls yesterday
  // (complete) + today (partial) each run; idempotent so all tasks racing to
  // UPSERT the same day is harmless (same note as supply metrics above). Each
  // run re-reads that day's events, so a tighter cadence costs more DynamoDB
  // reads at scale — hence `ANALYTICS_ROLLUP_INTERVAL_MINUTES` (default 15 for
  // a near-live dashboard in dev; raise it in prod, e.g. 60, to cut read cost).
  const rollupMinutes = Math.min(Math.max(Math.floor(Number(process.env.ANALYTICS_ROLLUP_INTERVAL_MINUTES) || 15), 1), 1440);
  const ANALYTICS_ROLLUP_INTERVAL_MS = rollupMinutes * 60_000;
  const runAnalyticsRollup = leased('analytics-rollup', ANALYTICS_ROLLUP_INTERVAL_MS, async () => {
    try {
      await analyticsRollupService.runDailyRollup();
    } catch (err: any) {
      logger.warn('Analytics rollup failed', { error: err.message });
    }
  });
  void runAnalyticsRollup(); // kick off once at boot so the tables aren't empty
  analyticsRollupTimer = setInterval(runAnalyticsRollup, ANALYTICS_ROLLUP_INTERVAL_MS);
  analyticsRollupTimer.unref();

  // Recovery sweeper for account export/deletion requests (PRIV-002): jobs
  // run in-process fire-and-forget, so this re-runs any 'requested' rows a
  // crashed task left behind (and stale 'processing' claims). Idempotent —
  // concurrent tasks racing on the same row are serialized by the claim
  // UPDATE. 5-minute cadence: these are rare, latency-tolerant requests.
  const ACCOUNT_LIFECYCLE_INTERVAL_MS = 5 * 60_000;
  const runAccountLifecycleSweep = leased('account-lifecycle-sweep', ACCOUNT_LIFECYCLE_INTERVAL_MS, async () => {
    try {
      await accountLifecycleService.processPending();
    } catch (err: any) {
      logger.warn('Account lifecycle sweep failed', { error: err.message });
    }
  });
  void runAccountLifecycleSweep(); // recover anything pending from before a restart
  accountLifecycleTimer = setInterval(runAccountLifecycleSweep, ACCOUNT_LIFECYCLE_INTERVAL_MS);
  accountLifecycleTimer.unref();

  // Start SQS notification worker (no-op if SQS_NOTIFICATION_QUEUE_URL not set)
  await notificationWorker.start();
}

start().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});

// Graceful shutdown
//
// ECS Fargate sends SIGTERM then waits up to `stopTimeout` (default 30s) before
// SIGKILL. Order matters:
//   1. Stop accepting new work (server.close, background timers, worker, WS).
//   2. Drain in-flight HTTP requests — server.close() resolves once all sockets
//      close, so ongoing booking/payment transactions can commit cleanly.
//   3. Only then release connection pools (Postgres, Redis). Closing them first
//      would abort whatever work we just asked to finish.
// A hard-exit fallback guards against a stuck socket holding us past the ECS
// SIGKILL deadline.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  if (holdCleanupTimer) clearInterval(holdCleanupTimer);
  if (supplyMetricsTimer) clearInterval(supplyMetricsTimer);
  if (analyticsRollupTimer) clearInterval(analyticsRollupTimer);
  if (accountLifecycleTimer) clearInterval(accountLifecycleTimer);
  notificationWorker.stop();
  wsRealtimeProvider.shutdown();

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 25_000);
  forceExit.unref();

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } catch (err: any) {
    logger.warn('server.close() errored during shutdown', { error: err?.message });
  }

  try { await pool.end(); } catch (err: any) {
    logger.warn('pg pool.end() errored during shutdown', { error: err?.message });
  }
  try { await redis.quit(); } catch (err: any) {
    logger.warn('redis.quit() errored during shutdown', { error: err?.message });
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export default app;
