import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Types } from "mongoose";
import { Job } from "bull";
import { QUEUE_RESERVATION_EXPIRY, JOB_EXPIRE_RESERVATIONS } from "../jobs.constants";
import { OrderService } from "../../order/order.service";
import { NotificationsService } from "../../notifications/notifications.service";

@Processor(QUEUE_RESERVATION_EXPIRY)
export class ReservationExpiryProcessor {
  private readonly logger = new Logger(ReservationExpiryProcessor.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly notifications: NotificationsService,
  ) {}

  @Process(JOB_EXPIRE_RESERVATIONS)
  async expire(_job: Job): Promise<void> {
    // ── Gateway orders past their reservationExpiresAt ────────────────────
    // Uses the new index-backed query instead of a fixed creation-time cutoff.
    const expiredGateway = await this.orderService.findExpiredReservations();

    if (expiredGateway.length > 0) {
      this.logger.log(`Expiring ${expiredGateway.length} expired reservation(s)`);
      for (const order of expiredGateway) {
        const orderId = (order._id as unknown as Types.ObjectId).toString();
        try {
          await this.orderService.markAbandoned(orderId);
          this.logger.log({
            event: "reservation_expired",
            orderNumber: order.orderNumber,
            reservationExpiresAt: order.reservationExpiresAt,
          });

          // Email the customer only if they actually started a payment attempt
          await this.notifications.sendOrderExpired(order);
        } catch (err) {
          this.logger.error(
            { event: "reservation_expiry_error", orderNumber: order.orderNumber },
            (err as Error).message,
          );
        }
      }
    }

    // ── POD orders not confirmed after 5 days → cancel + release stock ────
    const POD_EXPIRE_DAYS = 5;
    const stalePod = await this.orderService.findStalePodOrders(POD_EXPIRE_DAYS);

    if (stalePod.length > 0) {
      this.logger.log(`Expiring ${stalePod.length} unconfirmed POD order(s)`);
      for (const order of stalePod) {
        const orderId = (order._id as unknown as Types.ObjectId).toString();
        try {
          await this.orderService.markCancelled(orderId);
          await this.notifications.sendOrderCancelled(order);
          this.logger.log({
            event: "pod_order_expired",
            orderNumber: order.orderNumber,
          });
        } catch (err) {
          this.logger.error(
            { event: "pod_expiry_error", orderNumber: order.orderNumber },
            (err as Error).message,
          );
        }
      }
    }
  }
}
