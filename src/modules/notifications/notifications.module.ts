import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Order, OrderSchema } from "../order/schemas/order.schema";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }])],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
