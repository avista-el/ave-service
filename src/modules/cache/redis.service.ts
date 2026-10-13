import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis, { type RedisOptions } from "ioredis";

/**
 * Application-level Redis cache service.
 *
 * Design principles:
 *  - Failures are always non-fatal: every method returns null/void on error.
 *  - Commands MUST NOT queue when Redis is unreachable. enableOfflineQueue:false
 *    + maxRetriesPerRequest:0 ensures every command either succeeds immediately
 *    or throws (which the callers catch and swallow). Without this, commands
 *    pile up in ioredis's offline queue and hang every API endpoint until Redis
 *    reconnects — which can look like the whole backend is down.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private available = false;

  constructor(config: ConfigService) {
    const url = config.get<string>("redis.url");

    const sharedOpts: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: false,
      // CRITICAL: never queue commands while disconnected.
      // Each method wraps calls in try/catch; if Redis is down the catch
      // returns null/void immediately and the caller falls back to MongoDB.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
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

    this.client.on("connect", () => {
      this.available = true;
      this.logger.log("Redis connected");
    });
    this.client.on("close", () => {
      this.available = false;
    });
    this.client.on("error", (err: Error) => {
      // Only log once per disconnect cycle to avoid log spam.
      if (this.available) {
        this.logger.warn(`Redis error: ${err.message}`);
        this.available = false;
      }
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
    } catch (err) {
      // Non-fatal — ioredis will keep retrying in the background.
      this.logger.warn(`Redis initial connect failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
    } catch {
      // Ignore errors during shutdown
    }
  }

  // ─── Typed helpers ─────────────────────────────────────────────────────────

  /** Get and JSON-parse a cached value, or return null on any error/miss. */
  async getJson<T>(key: string): Promise<T | null> {
    if (!this.available) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  /** JSON-stringify and set with an optional TTL in seconds. */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.available) return;
    try {
      const serialised = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, serialised);
      } else {
        await this.client.set(key, serialised);
      }
    } catch {
      // Cache write failure must never break the request.
    }
  }

  /** Delete a single key. */
  async del(key: string): Promise<void> {
    if (!this.available) return;
    try {
      await this.client.del(key);
    } catch {
      // Non-fatal
    }
  }

  /** Delete all keys matching a glob pattern (e.g. "catalog:products:*"). */
  async delPattern(pattern: string): Promise<void> {
    if (!this.available) return;
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length) await this.client.del(...keys);
    } catch {
      // Non-fatal
    }
  }
}
