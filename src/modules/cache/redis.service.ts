import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis, { type RedisOptions } from "ioredis";

/**
 * Application-level Redis cache service.
 *
 * Uses composition rather than inheritance to avoid TypeScript's restriction on
 * branching before `super()` in derived classes that have initialised properties.
 *
 * Failures are non-fatal: every method silently returns null/void so the app
 * keeps working when Redis is unavailable.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>("redis.url");

    const sharedOpts: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: false,
      // ioredis types maxRetriesPerRequest as number | null; null means unlimited.
      maxRetriesPerRequest: null as unknown as number,
      enableOfflineQueue: true,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    };

    this.client = url
      ? new Redis(url, sharedOpts)
      : new Redis({
          host: config.get<string>("redis.host", "localhost"),
          port: config.get<number>("redis.port", 6379),
          password: config.get<string | undefined>("redis.password") || undefined,
          ...sharedOpts,
        });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      this.logger.log("Redis connected");
    } catch (err) {
      // Non-fatal — the app runs with cache misses if Redis is unreachable.
      this.logger.warn(`Redis connect failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  // ─── Typed helpers ─────────────────────────────────────────────────────────

  /** Get and JSON-parse a cached value, or return null. */
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  /** JSON-stringify and set with an optional TTL in seconds. */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const serialised = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, serialised);
      } else {
        await this.client.set(key, serialised);
      }
    } catch {
      // Swallow — a cache write failure must never break the request.
    }
  }

  /** Delete a single key. */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // Non-fatal
    }
  }

  /** Delete all keys matching a glob pattern (e.g. "catalog:products:*"). */
  async delPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length) await this.client.del(...keys);
    } catch {
      // Non-fatal
    }
  }
}
