import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { QUEUE_PAYMENT_RECONCILE, JOB_RECONCILE_PENDING } from "../jobs.constants";
import { OrderService } from "../../order/order.service";
import { PaymentService } from "../../payment/payment.service";

@Processor(QUEUE_PAYMENT_RECONCILE)
export class ReconcileProcessor {
  private readonly logger = new Logger(ReconcileProcessor.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
  ) {}

  @Process(JOB_RECONCILE_PENDING)
  async reconcile(_job: Job): Promise<void> {
    // Find all pending orders whose reservationExpiresAt has NOT yet passed
    // (expired ones are handled by ReservationExpiryProcessor).
    // We only reconcile orders that are still within their hold window and
    // have at least one INITIATED attempt.
    const pending = await this.orderService.findExpiredReservations();
    // findExpiredReservations returns orders past expiry — that's the expiry
    // processor's job.  For reconcile we want orders still in-window but
    // potentially paid (webhook missed).  Use the deprecated stale query as
    // a secondary sweep for the last 60 minutes.
    const RECONCILE_WINDOW_MINUTES = 60;
    const stale = await this.orderService.findStalePendingOrders(RECONCILE_WINDOW_MINUTES);

    if (stale.length === 0) return;

    this.logger.log(`Reconciling ${stale.length} pending order(s) in-window`);

    for (const order of stale) {
      // Find the most recent INITIATED attempt
      const latestRef = [...(order.paymentAttempts ?? [])]
        .reverse()
        .find((a) => a.status === "INITIATED")?.reference;

      const reference = latestRef ?? order.paymentReference;

      try {
        const { status } = await this.paymentService.verifyAndProcess(reference);
        this.logger.log({
          event: "reconcile_result",
          orderNumber: order.orderNumber,
          reference,
          status,
        });
      } catch (err) {
        this.logger.error(
          { event: "reconcile_error", orderNumber: order.orderNumber },
          (err as Error).message,
        );
      }
    }
  }
}
