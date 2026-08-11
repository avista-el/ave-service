import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { ScheduleModule } from "@nestjs/schedule";
import { BullModule } from "@nestjs/bull";
import configuration from "./config/configuration";

import { JobsModule } from "./modules/jobs/jobs.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CatalogModule } from "./modules/catalog/catalog.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { CartModule } from "./modules/cart/cart.module";
import { OrderModule } from "./modules/order/order.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { PromotionsModule } from "./modules/promotions/promotions.module";
import { GeoCurrencyModule } from "./modules/geo-currency/geo-currency.module";
import { MediaModule } from "./modules/media/media.module";
import { SearchModule } from "./modules/search/search.module";
import { AuditLogModule } from "./modules/audit-log/audit-log.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { SyncModule } from "./modules/sync/sync.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";

@Module({
  imports: [
    // ── Config ────────────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // ── MongoDB ───────────────────────────────────────────────────────────────
    // bufferCommands: true (default) means Mongoose queues operations until
    // connected — the app boots and the port opens immediately regardless of
    // how long Atlas takes to accept the connection.
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>("database.uri"),
        autoIndex: true,
        // Give Atlas up to 60 s to respond on first connect (cold-start)
        serverSelectionTimeoutMS: 60_000,
        socketTimeoutMS: 60_000,
        connectTimeoutMS: 60_000,
        // Keep trying to reconnect — never give up after initial timeout
        heartbeatFrequencyMS: 10_000,
      }),
    }),

    // ── BullMQ / Redis ────────────────────────────────────────────────────────
    // The Redis connection MUST NOT block the bootstrap sequence.
    // Key settings:
    //   maxRetriesPerRequest: null  → jobs queue without throwing on every call
    //   enableReadyCheck: false     → don't await a PING before resolving
    //   lazyConnect: true           → defer TCP connection until first command
    //   enableOfflineQueue: true    → queue commands while disconnected (default)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>("redis.url");

        // Shared ioredis options that prevent blocking on startup
        const sharedOpts = {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: true,
          enableOfflineQueue: true,
          retryStrategy: (times: number) => Math.min(times * 500, 10_000),
        };

        if (url) {
          // Render Redis / Upstash — rediss:// or redis:// connection string
          return {
            redis: url,
            // Pass ioredis options alongside the URL via the settings key
            settings: {
              lockDuration: 30_000,
            },
            defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
          } as unknown as { redis: { host: string; port: number } };
        }

        return {
          redis: {
            host: config.get<string>("redis.host", "localhost"),
            port: config.get<number>("redis.port", 6379),
            password: config.get<string | undefined>("redis.password") || undefined,
            ...sharedOpts,
          },
        };
      },
    }),

    // ── Scheduler ────────────────────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Feature modules ───────────────────────────────────────────────────────
    AuthModule,
    CatalogModule,
    InventoryModule,
    CartModule,
    OrderModule,
    PaymentModule,
    PromotionsModule,
    GeoCurrencyModule,
    MediaModule,
    SearchModule,
    AuditLogModule,
    AnalyticsModule,
    SyncModule,
    NotificationsModule,
    JobsModule,
  ],
})
export class AppModule {}
