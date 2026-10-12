import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(config: ConfigService) {
    const url = config.get<string>("redis.url");

    const sharedOpts = {
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: null as unknown as number,
      enableOfflineQueue: true,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    };

    if (url) {
      super(url, sharedOpts);
    } else {
      super({
        host: config.get<string>("redis.host", "localhost"),
        port: config.get<number>("redis.port", 6379),
        password: config.get<string | undefined>("redis.password") || undefined,
        ...sharedOpts,
      });
    }
  }

  async onModuleInit() {
    try {
      await this.connect();
      this.logger.log("Redis connected");
    } catch (err) {
      // Non-fatal: the app can run without Redis (cache will miss gracefully)
      this.logger.warn(`Redis connect failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.quit();
  }

  // ─── Typed helpers ─────────────────────────────────────────────────────────

  /** Get and JSON-parse a cached value, or return null. */
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.get(key);
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
        await this.setex(key, ttlSeconds, serialised);
      } else {
        await this.set(key, serialised);
      }
    } catch {
      // Swallow — cache write failure should never break the request
    }
  }

  /** Delete all keys matching a pattern (e.g. "catalog:products:*"). */
  async delPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.keys(pattern);
      if (keys.length) await this.del(...keys);
    } catch {
      // Non-fatal
    }
  }
}
