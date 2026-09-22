import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { DiscountCode, DiscountCodeSchema } from "./schemas/discount-code.schema";
import { PromotionsService } from "./promotions.service";
import { PriceResolutionService } from "./price-resolution.service";
import { PromotionsController, AdminPromotionsController } from "./promotions.controller";

@Module({
  imports: [MongooseModule.forFeature([{ name: DiscountCode.name, schema: DiscountCodeSchema }])],
  providers: [PromotionsService, PriceResolutionService],
  controllers: [PromotionsController, AdminPromotionsController],
  // Export both so CatalogModule and OrderModule can inject them.
  exports: [PromotionsService, PriceResolutionService],
})
export class PromotionsModule {}
