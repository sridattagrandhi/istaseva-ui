import { Request, Response } from 'express';
import { checkDatabaseHealth } from '../../../common/db/postgres.js';
import { checkRedisHealth } from '../../../common/cache/redis.js';
import { config } from '../../../common/config/index.js';
import { isImageModerationEnabled } from '../services/image-moderation.service.js';

export class HealthController {
  async getHealth(_req: Request, res: Response) {
    const [db, cache] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);

    // Redis is only load-bearing when it's the configured cache provider
    // (distributed locks, rate limits, booking holds all depend on it). When
    // the provider is 'memory' or 'noop', Redis being down is not a failure.
    const redisRequired = config.cache.provider === 'redis';
    const redisOk = redisRequired ? cache : true;
    const healthy = db && redisOk;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: db ? 'up' : 'down',
        redis: cache ? 'up' : 'down',
        // 'enabled' only reflects config (IMAGE_MODERATION_URL present at boot),
        // not reachability — the gate fails open per-request unless
        // IMAGE_MODERATION_FAIL_CLOSED is set.
        imageModeration: isImageModerationEnabled() ? 'enabled' : 'disabled',
      },
    });
  }
}

export const healthController = new HealthController();
