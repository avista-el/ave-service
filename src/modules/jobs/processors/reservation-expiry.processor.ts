import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Types } from "mongoose";
import { Job } from "bull";
import { QUEUE_RESERVATION_EXPIRY, JOB_EXPIRE_RESERVATIONS } from "../jobs.constants";
import { OrderService } from "../../order/order.service";

@Processor(QUEUE_RESERVATION_EXPIRY)
export class ReservationExpiryProcessor {
  private readonly logger = new Logger(ReservationExpiryProcessor.name);

  constructor(private readonly orderService: OrderService) {}

  @Process(JOB_EXPIRE_RESERVATIONS)
  async expire(_job: Job): Promise<void> {
    // ── Gateway orders stuck in pending_payment → abandon after 30 min ──────
    const PENDING_EXPIRE_MINUTES = 30;
    const staleGateway = await this.orderService.findStalePendingOrders(PENDING_EXPIRE_MINUTES);
    if (staleGateway.length > 0) {
      this.logger.log(`Expiring ${staleGateway.length} stale gateway reservation(s)`);
      for (const order of staleGateway) {
        const orderId = (order._id as unknown as Types.ObjectId).toString();
        try {
          await this.orderService.markAbandoned(orderId);
          this.logger.log(`Abandoned + released stock: ${order.orderNumber}`);
        } catch (err) {
          this.logger.error(`Error expiring ${order.orderNumber}`, (err as Error).message);
        }
      }
    }

    // ── POD orders not confirmed after 5 days → cancel + release stock ──────
    const POD_EXPIRE_DAYS = 5;
    const stalePod = await this.orderService.findStalePodOrders(POD_EXPIRE_DAYS);
    if (stalePod.length > 0) {
      this.logger.log(`Expiring ${stalePod.length} unconfirmed POD order(s)`);
      for (const order of stalePod) {
        const orderId = (order._id as unknown as Types.ObjectId).toString();
        try {
          await this.orderService.markCancelled(orderId);
          this.logger.log(`Cancelled unconfirmed POD order: ${order.orderNumber}`);
        } catch (err) {
          this.logger.error(
            `Error expiring POD order ${order.orderNumber}`,
            (err as Error).message,
          );
        }
      }
    }
  }
}
