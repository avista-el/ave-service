import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { WebhookEvent, WebhookEventSchema } from "./schemas/webhook-event.schema";
import { PaymentService } from "./payment.service";
import { PaymentController } from "./payment.controller";
import { OrderModule } from "../order/order.module";
import { InventoryModule } from "../inventory/inventory.module";
import { InstallmentModule } from "../installment/installment.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: WebhookEvent.name, schema: WebhookEventSchema }]),
    // forwardRef breaks the circular dep: PaymentModule → OrderModule → PaymentModule
    forwardRef(() => OrderModule),
    InventoryModule,
    InstallmentModule,
    NotificationsModule,
  ],
  providers: [PaymentService],
  controllers: [PaymentController],
  exports: [PaymentService],
})
export class PaymentModule {}
