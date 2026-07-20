import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { RedisStore, type SendCommandFn } from 'rate-limit-redis';
import { config } from '../common/config/index.js';
import { redis } from '../common/cache/redis.js';
import { logger } from '../common/logging/logger.js';
import { errorHandler } from '../common/http/error-handler.js';
import { requestLogger } from '../middleware/request-logger.js';
import { identifyForRateLimit } from '../common/auth/require-auth.js';
import { registerRoutes } from './register-routes.js';

export function createApp() {
  const app = express();

  const useRedis = config.cache.provider === 'redis';

  // We sit behind CloudFront → ALB → ECS. Without trust proxy, req.ip is the
  // ALB IP and X-Forwarded-For is ignored — rate limiters would key every
  // request under the same LB address. `1` trusts the first hop (the ALB);
  // the real client IP is the leftmost entry in X-Forwarded-For.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(compression());
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, mobile apps, etc.)
      if (!origin) return callback(null, true);
      const allowed = [
        config.app.frontendUrl,
        // Always allow both the custom domain and raw CloudFront domain
        'https://istaseva.com',
        'https://www.istaseva.com',
        'https://staging.istaseva.com',
        'http://localhost:5299',
        'http://localhost:8080',
        'http://localhost:5173',
      ].filter(Boolean);
      if (allowed.includes(origin) || config.app.corsAllowAll) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use((req, res, next) => {
    // Skip JSON body parsing for binary upload endpoints so express.raw() can handle them.
    // Payment webhook is also skipped — Razorpay signs the raw request bytes, so we need
    // the unparsed buffer to verify HMAC correctly.
    if (
      req.path === '/api/storage/upload' ||
      req.path.startsWith('/api/storage/local-upload/') ||
      req.path === '/api/payments/webhook'
    ) {
      return next();
    }
    express.json({ limit: '10mb' })(req, res, next);
  });
  // PRIVACY (SEC-013): log the path WITHOUT the query string — admin/user
  // search endpoints carry emails/phones/free-text queries in `?q=`, which
  // must not land in request logs. Otherwise mirrors morgan's 'combined'.
  morgan.token('pathname', (req) => {
    const url = (req as express.Request).originalUrl ?? req.url ?? '';
    const cut = url.indexOf('?');
    return cut === -1 ? url : url.slice(0, cut);
  });
  app.use(morgan(
    ':remote-addr - :remote-user [:date[clf]] ":method :pathname HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"',
    { stream: { write: (msg: string) => logger.info(msg.trim()) } },
  ));
  app.use(requestLogger);

  // Helper: build a rate-limit middleware with a Redis-backed store when
  // available. keyGenerator prefers req.user.id (after requireAuth has run)
  // and falls back to client IP, so per-user limits apply to authenticated
  // traffic and per-IP limits protect public endpoints.
  const makeLimiter = (opts: {
    prefix: string;
    windowMs: number;
    max: number;
    methods?: ReadonlyArray<string>;
  }) => {
    // max=0 disables the limiter entirely (used in load-test environments).
    if (opts.max === 0) return (_req: Request, _res: Response, next: NextFunction) => next();
    return rateLimit({
      windowMs: opts.windowMs,
      max: opts.max,
      standardHeaders: true,
      legacyHeaders: false,
      // Only count the specified methods toward the limit (e.g. writes only).
      skip: opts.methods ? (req) => !opts.methods!.includes(req.method) : undefined,
      // Key per authenticated user when known (SEC-007), falling back to IP
      // for anonymous traffic. `rateLimitUserId` is populated by the
      // `identifyForRateLimit` pass mounted below, which runs BEFORE these
      // limiters — unlike `requireAuth`, which runs later in each route chain.
      keyGenerator: (req) => req.rateLimitUserId ?? req.ip ?? 'unknown',
      ...(useRedis && {
        store: new RedisStore({
          // ioredis' `call` is Promise<unknown>; rate-limit-redis wants its own
          // RedisReply union — the shapes are runtime-compatible.
          sendCommand: ((...args: string[]) => redis.call(args[0], ...args.slice(1))) as unknown as SendCommandFn,
          prefix: opts.prefix,
        }),
      }),
    });
  };

  const rl = config.rateLimit;

  // Broad safety net on everything under /api. This is NOT the primary abuse
  // defense — the per-path write limiters below (messages/bookings/reviews)
  // are. Sized for:
  //   • Authenticated user browsing: ~3 req/s sustained = 2700/15min,
  //     so 5000 gives ~2x headroom for bursts.
  //   • Unauthenticated/IP-keyed traffic: many real users share one IP
  //     behind corporate NATs and mobile CGNAT, so the key fans out;
  //     5000/15min keeps legitimate NATed traffic flowing.
  //   • Load testing from a single source will still hit this ceiling at
  //     ~5 req/s sustained — that's expected. Run tests from multiple
  //     sources (or inside the VPC bypassing the limiter entirely) to
  //     exercise the downstream stack at real concurrency.
  // Best-effort per-user identification for the limiters below (SEC-007). Must
  // run before every limiter so authenticated traffic is keyed per-user, not
  // per-IP. Does NOT authorize — `requireAuth` still gates the routes.
  app.use('/api/', identifyForRateLimit);

  app.use('/api/', makeLimiter({ prefix: 'rl:api:', windowMs: rl.api.windowMs, max: rl.api.max }));

  // Tight cap on auth endpoints — slows down credential stuffing.
  app.use('/api/auth/', makeLimiter({ prefix: 'rl:auth:', windowMs: rl.auth.windowMs, max: rl.auth.max }));

  // ── Write hot-paths: per-minute caps by user (or IP if unauthenticated) ──
  // These are abuse vectors — sending messages, creating bookings, posting
  // reviews. 60/min is well above any legitimate human use but stops scripts
  // dead. Limits apply only to mutating methods; reads go through the broad
  // /api limiter.
  const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

  app.use(
    '/api/messages',
    makeLimiter({ prefix: 'rl:msg:', windowMs: rl.messages.windowMs, max: rl.messages.max, methods: writeMethods })
  );
  app.use(
    '/api/bookings',
    makeLimiter({ prefix: 'rl:book:', windowMs: rl.bookings.windowMs, max: rl.bookings.max, methods: writeMethods })
  );
  app.use(
    '/api/reviews',
    makeLimiter({ prefix: 'rl:rev:', windowMs: rl.reviews.windowMs, max: rl.reviews.max, methods: writeMethods })
  );

  // Search scraping prevention — GETs only, but at a high enough cap for
  // normal browsing.
  app.use(
    '/api/search',
    makeLimiter({ prefix: 'rl:search:', windowMs: rl.search.windowMs, max: rl.search.max })
  );

  // Payments — fraud / order-spam guard. Writes only; verify endpoints are
  // tight because each call hits Razorpay/Stripe and may charge a card.
  app.use(
    '/api/payments',
    makeLimiter({ prefix: 'rl:pay:', windowMs: rl.payments.windowMs, max: rl.payments.max, methods: writeMethods })
  );

  // LLM-backed endpoints. These hit paid third-party APIs, so cost-control is
  // the main motivation, not abuse per se. Applied per-user (or IP) on writes.
  app.use(
    '/api/onboarding-chat',
    makeLimiter({ prefix: 'rl:llm:onb:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  app.use(
    '/api/smart-schedule',
    makeLimiter({ prefix: 'rl:llm:sch:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  app.use(
    '/api/chat',
    makeLimiter({ prefix: 'rl:llm:chat:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  // Ista AI assistant + TTS — the priciest per-call AI endpoints (each assistant
  // turn is a multi-tool agent loop; TTS hits a paid synth API). Both are
  // authenticated POST-only, so per-user keying (above) gives real denial-of-
  // wallet protection. Previously covered only by the broad /api net.
  app.use(
    '/api/assistant',
    makeLimiter({ prefix: 'rl:llm:asst:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  app.use(
    '/api/tts',
    makeLimiter({ prefix: 'rl:llm:tts:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  // Translation is an unauthenticated proxy to a paid translation backend (it
  // serves anonymous browsers translating public content, so it stays public) —
  // rate-limit per-IP to cap cost abuse. Requests batch up to 100 strings each.
  app.use(
    '/api/translation',
    makeLimiter({ prefix: 'rl:llm:txn:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );
  // Geocoding is the same shape as translation: an unauthenticated proxy to a
  // paid Google API (geocode / autocomplete / place-details serve the public
  // search bar). Same per-IP cap so an anonymous caller can't farm our
  // Google Maps quota through the open endpoint.
  app.use(
    '/api/geocode',
    makeLimiter({ prefix: 'rl:llm:geo:', windowMs: rl.llm.windowMs, max: rl.llm.max, methods: writeMethods })
  );

  // S3 presigned uploads — prevents URL farming. Covers all four presign/
  // direct-storage routes (the mount previously said "presigned-upload",
  // a path that doesn't exist — the limiter never matched anything).
  app.use(
    ['/api/storage/presign-upload', '/api/storage/presign-download', '/api/storage/delete', '/api/storage/list'],
    makeLimiter({ prefix: 'rl:upload:', windowMs: rl.uploads.windowMs, max: rl.uploads.max })
  );

  // Proxy image upload — each POST runs the paid NSFW-moderation service, so an
  // unthrottled caller is a cost/DoS amplifier. This is the actual upload path
  // (the presigned limiter above only covers URL minting).
  app.use(
    '/api/storage/upload',
    makeLimiter({ prefix: 'rl:upload-proxy:', windowMs: rl.uploads.windowMs, max: rl.uploads.max, methods: writeMethods })
  );

  // Coupon apply/validate — throttles code brute-forcing and enumeration.
  app.use(
    '/api/coupons',
    makeLimiter({ prefix: 'rl:coupon:', windowMs: rl.coupons.windowMs, max: rl.coupons.max, methods: writeMethods })
  );

  // Listings browse — generous cap for infinite-scroll, still well under the
  // global /api floor. Mostly to discourage scrapers that bypass /api/search.
  app.use(
    '/api/listings',
    makeLimiter({ prefix: 'rl:list:', windowMs: rl.listings.windowMs, max: rl.listings.max })
  );

  // Serve locally uploaded files when using local storage provider
  if (config.storage.provider === 'local') {
    const uploadRoot = path.resolve(process.cwd(), '.local-uploads');
    app.use('/uploads', express.static(uploadRoot));
  }

  registerRoutes(app);
  app.use(errorHandler);

  return app;
}
