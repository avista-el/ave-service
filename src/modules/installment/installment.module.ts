import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { BullModule } from "@nestjs/bull";
import { InstallmentPlan, InstallmentPlanSchema } from "./schemas/installment-plan.schema";
import { InstallmentService } from "./installment.service";
import { InstallmentController } from "./installment.controller";
import { OrderModule } from "../order/order.module";
import { InventoryModule } from "../inventory/inventory.module";
import {
  QUEUE_INSTALLMENT_CHARGE,
  QUEUE_INSTALLMENT_REMINDER,
} from "../jobs/jobs.constants";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: InstallmentPlan.name, schema: InstallmentPlanSchema },
    ]),
    BullModule.registerQueue(
      { name: QUEUE_INSTALLMENT_CHARGE },
      { name: QUEUE_INSTALLMENT_REMINDER },
    ),
    OrderModule,
    InventoryModule,
  ],
  providers: [InstallmentService],
  controllers: [InstallmentController],
  exports: [InstallmentService, MongooseModule],
})
export class InstallmentModule {}
