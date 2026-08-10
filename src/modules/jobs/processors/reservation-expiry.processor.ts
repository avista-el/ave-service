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
    const EXPIRE_MINUTES = 30;
    const stale = await this.orderService.findStalePendingOrders(EXPIRE_MINUTES);
    if (stale.length === 0) return;
    this.logger.log(`Expiring ${stale.length} abandoned reservation(s)`);

    for (const order of stale) {
      const orderId = (order._id as unknown as Types.ObjectId).toString();
      try {
        await this.orderService.markAbandoned(orderId);
        this.logger.log(`Abandoned + released stock: ${order.orderNumber}`);
      } catch (err) {
        this.logger.error(`Error expiring ${order.orderNumber}`, (err as Error).message);
      }
    }
  }
}
