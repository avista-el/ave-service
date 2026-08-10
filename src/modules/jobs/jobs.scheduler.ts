import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  QUEUE_PAYMENT_RECONCILE,
  QUEUE_RESERVATION_EXPIRY,
  JOB_RECONCILE_PENDING,
  JOB_EXPIRE_RESERVATIONS,
} from './jobs.constants';

/**
 * Schedules recurring BullMQ jobs on module init.
 * Using Bull's built-in `repeat` option so jobs survive restarts
 * and are deduplicated across multiple API instances.
 */
@Injectable()
export class JobsScheduler implements OnModuleInit {
  private readonly logger = new Logger(JobsScheduler.name);

  constructor(
    @InjectQueue(QUEUE_PAYMENT_RECONCILE)
    private readonly reconcileQueue: Queue,
    @InjectQueue(QUEUE_RESERVATION_EXPIRY)
    private readonly expiryQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Payment reconciliation — every 10 minutes
    await this.reconcileQueue.add(
      JOB_RECONCILE_PENDING,
      {},
      {
        repeat: { cron: '*/10 * * * *' },
        removeOnComplete: 20,
        removeOnFail: 50,
        jobId: 'reconcile-pending-recurring',
      },
    );

    // Reservation expiry — every 15 minutes
    await this.expiryQueue.add(
      JOB_EXPIRE_RESERVATIONS,
      {},
      {
        repeat: { cron: '*/15 * * * *' },
        removeOnComplete: 20,
        removeOnFail: 50,
        jobId: 'expire-reservations-recurring',
      },
    );

    this.logger.log('Recurring jobs scheduled');
  }
}
