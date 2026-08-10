import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import {
  QUEUE_PAYMENT_RECONCILE,
  QUEUE_RESERVATION_EXPIRY,
  QUEUE_SEARCH_INDEX,
  QUEUE_NOTIFICATIONS,
} from './jobs.constants';
import { ReconcileProcessor } from './processors/reconcile.processor';
import { ReservationExpiryProcessor } from './processors/reservation-expiry.processor';
import { SearchIndexProcessor } from './processors/search-index.processor';
import { JobsScheduler } from './jobs.scheduler';
import { OrderModule } from '../order/order.module';
import { PaymentModule } from '../payment/payment.module';
import { SearchModule } from '../search/search.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_PAYMENT_RECONCILE },
      { name: QUEUE_RESERVATION_EXPIRY },
      { name: QUEUE_SEARCH_INDEX },
      { name: QUEUE_NOTIFICATIONS },
    ),
    OrderModule,
    PaymentModule,
    SearchModule,
    CatalogModule,
  ],
  providers: [
    ReconcileProcessor,
    ReservationExpiryProcessor,
    SearchIndexProcessor,
    JobsScheduler,
  ],
  exports: [BullModule],
})
export class JobsModule {}
