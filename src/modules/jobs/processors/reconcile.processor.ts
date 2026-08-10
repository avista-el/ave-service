import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Types } from "mongoose";
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
    const STALE_MINUTES = 30;
    const stale = await this.orderService.findStalePendingOrders(STALE_MINUTES);
    if (stale.length === 0) return;
    this.logger.log(`Reconciling ${stale.length} stale pending order(s)`);

    for (const order of stale) {
      const orderId = (order._id as unknown as Types.ObjectId).toString();
      try {
        if (order.paymentProvider === "paystack") {
          const status = await this.paymentService.verifyPaystackTransaction(
            order.paymentReference,
          );
          if (status === "success") {
            await this.orderService.markPaid(orderId, `reconcile:${order.paymentReference}`);
            this.logger.log(`Reconciled paid: ${order.orderNumber}`);
          } else if (status === "failed" || status === "abandoned") {
            await this.orderService.markFailed(orderId);
            this.logger.log(`Reconciled failed: ${order.orderNumber}`);
          }
        }
      } catch (err) {
        this.logger.error(`Reconcile error for ${order.orderNumber}`, (err as Error).message);
      }
    }
  }
}
