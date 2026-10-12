import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { RedisService } from "./redis.service";

/**
 * Global cache module — import once in AppModule.
 * Exports RedisService so any feature module can inject it without re-importing.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class AppCacheModule {}
