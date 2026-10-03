import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Job, Queue } from "bull";
import {
  QUEUE_INSTALLMENT_CHARGE,
  QUEUE_INSTALLMENT_REMINDER,
  JOB_CHARGE_INSTALLMENT,
  JOB_REMIND_INSTALLMENT,
} from "../jobs.constants";
import { PaymentService } from "../../payment/payment.service";
import { InstallmentService } from "../../installment/installment.service";

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1 * 24 * 60 * 60 * 1000, 3 * 24 * 60 * 60 * 1000]; // +1d, +3d

@Processor(QUEUE_INSTALLMENT_CHARGE)
export class InstallmentChargeProcessor {
  private readonly logger = new Logger(InstallmentChargeProcessor.name);

  constructor(
    @InjectQueue(QUEUE_INSTALLMENT_CHARGE)
    private readonly chargeQueue: Queue,
    private readonly paymentService: PaymentService,
    private readonly installmentService: InstallmentService,
  ) {}

  @Process(JOB_CHARGE_INSTALLMENT)
  async charge(
    job: Job<{ planId: string; installmentNumber: number; attempt?: number }>,
  ): Promise<void> {
    const { planId, installmentNumber, attempt = 0 } = job.data;

    // Idempotency — skip if already paid or plan no longer active
    const plan = await this.installmentService.findById(planId);
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);
    if (!entry || entry.status === "paid" || plan.status !== "active") {
      this.logger.log(`Skipping instalment #${installmentNumber} for plan ${planId} (already resolved)`);
      return;
    }

    this.logger.log(`Charging instalment #${installmentNumber} for plan ${planId} (attempt ${attempt + 1})`);

    try {
      await this.paymentService.chargeInstallment(planId, installmentNumber);
      // Outcome confirmed asynchronously via webhook — job done here
    } catch (err) {
      this.logger.error(`Charge attempt ${attempt + 1} failed: ${(err as Error).message}`);
      await this.installmentService.markEntryFailed(planId, installmentNumber);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
        await this.chargeQueue.add(
          JOB_CHARGE_INSTALLMENT,
          { planId, installmentNumber, attempt: attempt + 1 },
          {
            delay,
            removeOnComplete: true,
            removeOnFail: false,
            jobId: `charge-${planId}-${installmentNumber}-retry${attempt + 1}`,
          },
        );
        this.logger.log(`Retry ${attempt + 1} queued for plan ${planId} #${installmentNumber} in ${delay / 3600000}h`);
      } else {
        // All retries exhausted — mark overdue; daily scan will handle default
        await this.installmentService.markEntryOverdue(planId, installmentNumber);
        this.logger.warn(`Plan ${planId} instalment #${installmentNumber} is now overdue after ${MAX_RETRIES + 1} attempts`);
      }
    }
  }
}

@Processor(QUEUE_INSTALLMENT_REMINDER)
export class InstallmentReminderProcessor {
  private readonly logger = new Logger(InstallmentReminderProcessor.name);

  constructor(private readonly installmentService: InstallmentService) {}

  @Process(JOB_REMIND_INSTALLMENT)
  async remind(
    job: Job<{ planId: string; installmentNumber: number }>,
  ): Promise<void> {
    const { planId, installmentNumber } = job.data;
    const plan = await this.installmentService.findById(planId);
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);

    // Only remind if the entry is still pending
    if (!entry || entry.status !== "pending") return;

    const order = await (this.installmentService as any).orderService.findById(
      plan.orderId.toString(),
    );

    this.logger.log(
      `Sending instalment reminder for plan ${planId} #${installmentNumber} ` +
        `due ${entry.dueDate.toISOString()} — order ${order.orderNumber}`,
    );

    // TODO: integrate with NotificationsModule once email templates are built
    // notificationsService.sendEmail({
    //   to: order.customerEmail,
    //   template: 'installment-reminder',
    //   data: { orderNumber: order.orderNumber, amount: entry.amount, dueDate: entry.dueDate }
    // });
  }
}
