import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Order, OrderSchema } from "./schemas/order.schema";
import { Cart, CartSchema } from "../cart/schemas/cart.schema";
import { InventoryModule } from "../inventory/inventory.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { CatalogModule } from "../catalog/catalog.module";
import { OrderService } from "./order.service";
import { OrderController, AdminOrderController } from "./order.controller";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Cart.name, schema: CartSchema },
    ]),
    InventoryModule,
    // Provides PriceResolutionService for server-side price revalidation at checkout.
    PromotionsModule,
    // Re-exports MongooseModule so OrderService can @InjectModel(Product.name).
    CatalogModule,
  ],
  providers: [OrderService],
  controllers: [OrderController, AdminOrderController],
  exports: [OrderService, MongooseModule],
})
export class OrderModule {}
