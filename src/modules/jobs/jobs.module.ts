import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import {
  QUEUE_PAYMENT_RECONCILE,
  QUEUE_RESERVATION_EXPIRY,
  QUEUE_SEARCH_INDEX,
  QUEUE_NOTIFICATIONS,
  QUEUE_INSTALLMENT_CHARGE,
  QUEUE_INSTALLMENT_REMINDER,
  QUEUE_INSTALLMENT_DEFAULT,
} from "./jobs.constants";
import { ReconcileProcessor } from "./processors/reconcile.processor";
import { ReservationExpiryProcessor } from "./processors/reservation-expiry.processor";
import { SearchIndexProcessor } from "./processors/search-index.processor";
import {
  InstallmentChargeProcessor,
  InstallmentReminderProcessor,
} from "./processors/installment-charge.processor";
import { InstallmentDefaultProcessor } from "./processors/installment-default.processor";
import { JobsScheduler } from "./jobs.scheduler";
import { OrderModule } from "../order/order.module";
import { PaymentModule } from "../payment/payment.module";
import { SearchModule } from "../search/search.module";
import { CatalogModule } from "../catalog/catalog.module";
import { InstallmentModule } from "../installment/installment.module";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_PAYMENT_RECONCILE },
      { name: QUEUE_RESERVATION_EXPIRY },
      { name: QUEUE_SEARCH_INDEX },
      { name: QUEUE_NOTIFICATIONS },
      { name: QUEUE_INSTALLMENT_CHARGE },
      { name: QUEUE_INSTALLMENT_REMINDER },
      { name: QUEUE_INSTALLMENT_DEFAULT },
    ),
    OrderModule,
    PaymentModule,
    SearchModule,
    CatalogModule,
    InstallmentModule,
  ],
  providers: [
    ReconcileProcessor,
    ReservationExpiryProcessor,
    SearchIndexProcessor,
    InstallmentChargeProcessor,
    InstallmentReminderProcessor,
    InstallmentDefaultProcessor,
    JobsScheduler,
  ],
  exports: [BullModule],
})
export class JobsModule {}
