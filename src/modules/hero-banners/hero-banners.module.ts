import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { HeroBanner, HeroBannerSchema } from "./schemas/hero-banner.schema";
import { HeroBannersService } from "./hero-banners.service";
import { HeroBannersController, AdminHeroBannersController } from "./hero-banners.controller";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: HeroBanner.name, schema: HeroBannerSchema }]),
  ],
  providers: [HeroBannersService],
  controllers: [HeroBannersController, AdminHeroBannersController],
  exports: [HeroBannersService],
})
export class HeroBannersModule {}
