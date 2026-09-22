import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Cart, CartSchema } from "./schemas/cart.schema";
import { CatalogModule } from "../catalog/catalog.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { CartService } from "./cart.service";
import { CartController } from "./cart.controller";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Cart.name, schema: CartSchema }]),
    CatalogModule,
    PromotionsModule,
  ],
  providers: [CartService],
  controllers: [CartController],
  exports: [CartService],
})
export class CartModule {}
