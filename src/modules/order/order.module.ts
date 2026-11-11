import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { Order, OrderSchema } from "./schemas/order.schema";
import { Cart, CartSchema } from "../cart/schemas/cart.schema";
import { InventoryModule } from "../inventory/inventory.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { CatalogModule } from "../catalog/catalog.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentModule } from "../payment/payment.module";
import { OrderService } from "./order.service";
import { OrderController, AdminOrderController } from "./order.controller";

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Cart.name, schema: CartSchema },
    ]),
    InventoryModule,
    PromotionsModule,
    CatalogModule,
    NotificationsModule,
    // forwardRef breaks the OrderModule ↔ PaymentModule circular dependency.
    // OrderController needs PaymentService for the retry-payment endpoint.
    forwardRef(() => PaymentModule),
  ],
  providers: [OrderService],
  controllers: [OrderController, AdminOrderController],
  exports: [OrderService, MongooseModule],
})
export class OrderModule {}
