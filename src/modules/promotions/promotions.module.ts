import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DiscountCode, DiscountCodeSchema } from './schemas/discount-code.schema';
import { PromotionsService } from './promotions.service';
import { PromotionsController, AdminPromotionsController } from './promotions.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DiscountCode.name, schema: DiscountCodeSchema },
    ]),
  ],
  providers: [PromotionsService],
  controllers: [PromotionsController, AdminPromotionsController],
  exports: [PromotionsService],
})
export class PromotionsModule {}
