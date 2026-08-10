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
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>("database.uri"),
        autoIndex: true,
        // Retry connection on startup — handles Atlas cold-start latency
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
      }),
    }),

    // ── BullMQ / Redis ────────────────────────────────────────────────────────
    // maxRetriesPerRequest: null  → Bull keeps retrying failed jobs indefinitely
    //   rather than crashing the process when Redis isn't available at startup.
    // enableReadyCheck: false     → don't block app boot waiting for Redis PING.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>("redis.url");
        const redisOpts = {
          maxRetriesPerRequest: null as unknown as number,
          enableReadyCheck: false,
          retryStrategy: (times: number) => Math.min(times * 1000, 30_000),
          lazyConnect: true,
        };

        if (url) {
          return {
            redis: { ...redisOpts, ...(url as unknown as object) },
            url,
          } as unknown as { redis: { host: string; port: number } };
        }

        return {
          redis: {
            host: config.get<string>("redis.host", "localhost"),
            port: config.get<number>("redis.port", 6379),
            password: config.get<string | undefined>("redis.password"),
            ...redisOpts,
          },
        };
      },
    }),

    // ── Scheduler (cron jobs via @nestjs/schedule) ────────────────────────────
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
