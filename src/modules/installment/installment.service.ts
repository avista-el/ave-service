import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { InjectQueue } from "@nestjs/bull";
import { Model, Types } from "mongoose";
import { Queue } from "bull";
import { ConfigService } from "@nestjs/config";
import {
  InstallmentPlan,
  InstallmentPlanDocument,
  ScheduleEntry,
} from "./schemas/installment-plan.schema";
import { OrderService } from "../order/order.service";
import { InventoryService } from "../inventory/inventory.service";
import {
  QUEUE_INSTALLMENT_CHARGE,
  QUEUE_INSTALLMENT_REMINDER,
  JOB_CHARGE_INSTALLMENT,
  JOB_REMIND_INSTALLMENT,
  JOB_DEFAULT_SCAN,
} from "../jobs/jobs.constants";

/** Business rule constants — centralised so they're easy to change */
export const BNPL = {
  MIN_ORDER_VALUE: 50_000,      // NGN — below this, Pay Small Small is not offered
  DEPOSIT_RATE: 0.4,             // 40% deposit
  INTEREST_RATE: 0.1,            // 10% flat on balance
  NUM_INSTALLMENTS: 3,
  FREQUENCY_MONTHS: 1,
  FORFEIT_PROACTIVE: 0.05,       // 5%  — customer cancels before any missed payment
  FORFEIT_DEFAULT: 0.10,         // 10% — missed payment, exhausted retries
};

@Injectable()
export class InstallmentService {
  private readonly logger = new Logger(InstallmentService.name);

  constructor(
    @InjectModel(InstallmentPlan.name)
    private readonly planModel: Model<InstallmentPlanDocument>,
    @InjectQueue(QUEUE_INSTALLMENT_CHARGE)
    private readonly chargeQueue: Queue,
    @InjectQueue(QUEUE_INSTALLMENT_REMINDER)
    private readonly reminderQueue: Queue,
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly config: ConfigService,
  ) {}

  // ─── Compute plan figures from cashPrice ─────────────────────────────────

  static computePlanFigures(cashPrice: number) {
    const depositAmount = Math.round(cashPrice * BNPL.DEPOSIT_RATE);
    const balancePrincipal = cashPrice - depositAmount;
    const interestAmount = Math.round(balancePrincipal * BNPL.INTEREST_RATE);
    const totalRepayable = balancePrincipal + interestAmount;
    const installmentAmount = Math.round(totalRepayable / BNPL.NUM_INSTALLMENTS);
    return { depositAmount, balancePrincipal, interestAmount, totalRepayable, installmentAmount };
  }

  // ─── Create plan after deposit webhook confirms ───────────────────────────

  async createPlan(opts: {
    orderId: string;
    customerId: string;
    cashPrice: number;
    authorizationCode: string;
    provider: "paystack" | "flutterwave";
  }): Promise<InstallmentPlanDocument> {
    const { depositAmount, balancePrincipal, interestAmount, totalRepayable, installmentAmount } =
      InstallmentService.computePlanFigures(opts.cashPrice);

    // Build schedule: 3 entries at +1, +2, +3 months from now
    const now = new Date();
    const schedule: ScheduleEntry[] = Array.from({ length: BNPL.NUM_INSTALLMENTS }, (_, i) => {
      const dueDate = new Date(now);
      dueDate.setMonth(dueDate.getMonth() + (i + 1) * BNPL.FREQUENCY_MONTHS);
      return {
        installmentNumber: i + 1,
        dueDate,
        amount: installmentAmount,
        status: "pending",
        paidAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        paymentReference: null,
      };
    });

    const plan = await this.planModel.create({
      orderId: new Types.ObjectId(opts.orderId),
      customerId: opts.customerId,
      cashPrice: opts.cashPrice,
      depositAmount,
      balancePrincipal,
      interestRate: BNPL.INTEREST_RATE,
      interestAmount,
      totalRepayable,
      installmentAmount,
      numberOfInstallments: BNPL.NUM_INSTALLMENTS,
      frequency: "monthly",
      amountPaidToDate: depositAmount,  // deposit already received
      schedule,
      authorizationCode: opts.authorizationCode,
      provider: opts.provider,
      status: "active",
    });

    // Queue one scheduled charge job + one reminder job per instalment entry
    for (const entry of schedule) {
      const delayMs = entry.dueDate.getTime() - Date.now();
      const reminderMs = delayMs - 2 * 24 * 60 * 60 * 1000; // 2 days before

      await this.chargeQueue.add(
        JOB_CHARGE_INSTALLMENT,
        {
          planId: (plan._id as Types.ObjectId).toString(),
          installmentNumber: entry.installmentNumber,
        },
        {
          delay: Math.max(0, delayMs),
          removeOnComplete: true,
          removeOnFail: false,
          jobId: `charge-${(plan._id as Types.ObjectId).toString()}-${entry.installmentNumber}`,
        },
      );

      if (reminderMs > 0) {
        await this.reminderQueue.add(
          JOB_REMIND_INSTALLMENT,
          {
            planId: (plan._id as Types.ObjectId).toString(),
            installmentNumber: entry.installmentNumber,
          },
          {
            delay: reminderMs,
            removeOnComplete: true,
            removeOnFail: false,
            jobId: `remind-${(plan._id as Types.ObjectId).toString()}-${entry.installmentNumber}`,
          },
        );
      }
    }

    this.logger.log(`InstallmentPlan created for order ${opts.orderId}`);
    return plan;
  }

  // ─── Record a successful instalment payment (called from webhook) ─────────

  async recordInstallmentPayment(opts: {
    planId: string;
    installmentNumber: number;
    paymentReference: string;
  }): Promise<void> {
    const plan = await this.planModel.findById(opts.planId);
    if (!plan) throw new NotFoundException(`InstallmentPlan ${opts.planId} not found`);
    if (plan.status !== "active") return; // guard for late webhooks

    const entry = plan.schedule.find(
      (s) => s.installmentNumber === opts.installmentNumber,
    );
    if (!entry) return;
    if (entry.status === "paid") return; // idempotent

    entry.status = "paid";
    entry.paidAt = new Date();
    entry.paymentReference = opts.paymentReference;
    plan.amountPaidToDate += entry.amount;

    const allPaid = plan.schedule.every((s) => s.status === "paid");
    if (allPaid) {
      plan.status = "completed";
      const order = await this.orderService.findById(plan.orderId.toString());
      await this.orderService.markPaid(
        plan.orderId.toString(),
        `installment-complete-${opts.planId}`,
      );
      this.logger.log(`InstallmentPlan ${opts.planId} completed — order marked paid`);
    }

    plan.markModified("schedule");
    await plan.save();
  }

  // ─── Mark a schedule entry as failed (called from charge job on sync error) ─

  async markEntryFailed(planId: string, installmentNumber: number): Promise<void> {
    const plan = await this.planModel.findById(planId);
    if (!plan || plan.status !== "active") return;
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);
    if (!entry || entry.status === "paid") return;
    entry.status = "failed";
    entry.attemptCount += 1;
    entry.lastAttemptAt = new Date();
    plan.markModified("schedule");
    await plan.save();
  }

  // ─── Mark an entry as overdue (called after all retries exhausted) ────────

  async markEntryOverdue(planId: string, installmentNumber: number): Promise<void> {
    const plan = await this.planModel.findById(planId);
    if (!plan || plan.status !== "active") return;
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);
    if (!entry) return;
    entry.status = "overdue";
    plan.markModified("schedule");
    await plan.save();
  }

  // ─── Customer-initiated plan cancellation ────────────────────────────────

  async cancelPlan(planId: string, customerId: string): Promise<InstallmentPlanDocument> {
    const plan = await this.planModel.findById(planId);
    if (!plan) throw new NotFoundException("InstallmentPlan not found");
    if (plan.customerId !== customerId) {
      throw new BadRequestException("This plan does not belong to you");
    }
    if (plan.status !== "active") {
      throw new BadRequestException(
        `Plan cannot be cancelled — current status: ${plan.status}`,
      );
    }

    const hasMissed = plan.schedule.some(
      (s) => s.status === "failed" || s.status === "overdue",
    );
    if (hasMissed) {
      throw new BadRequestException(
        "A payment has already been missed on this plan. Cancel is only available for proactive cancellations before any failed payment.",
      );
    }

    plan.status = "cancelled";
    plan.forfeitRate = BNPL.FORFEIT_PROACTIVE;
    plan.forfeitAmount = Math.round(plan.amountPaidToDate * BNPL.FORFEIT_PROACTIVE);

    // Reverse committed stock
    const order = await this.orderService.findById(plan.orderId.toString());
    for (const item of order.items) {
      await this.inventoryService.reverseCommittedStock(item.productId, item.qty);
    }

    // Cancel the order
    await this.orderService.markCancelledByInstallmentPlan(plan.orderId.toString());

    await plan.save();

    this.logger.log(
      `InstallmentPlan ${planId} cancelled proactively. Forfeit: ₦${plan.forfeitAmount}`,
    );
    return plan;
  }

  // ─── Default scan (called by daily cron job) ──────────────────────────────

  async runDefaultScan(): Promise<void> {
    const plans = await this.planModel.find({
      status: "active",
      "schedule.status": "overdue",
    });

    this.logger.log(`Default scan: found ${plans.length} plan(s) with overdue entries`);

    for (const plan of plans) {
      try {
        plan.status = "defaulted";
        plan.defaultedAt = new Date();
        plan.forfeitRate = BNPL.FORFEIT_DEFAULT;
        plan.forfeitAmount = Math.round(plan.amountPaidToDate * BNPL.FORFEIT_DEFAULT);

        // Reverse committed stock
        const order = await this.orderService.findById(plan.orderId.toString());
        for (const item of order.items) {
          await this.inventoryService.reverseCommittedStock(item.productId, item.qty);
        }

        await this.orderService.markCancelledByInstallmentPlan(plan.orderId.toString());

        await plan.save();

        this.logger.log(
          `Plan ${(plan._id as Types.ObjectId).toString()} defaulted. Forfeit: ₦${plan.forfeitAmount}`,
        );
      } catch (err) {
        this.logger.error(
          `Error defaulting plan ${(plan._id as Types.ObjectId).toString()}`,
          (err as Error).message,
        );
      }
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async findByOrder(orderId: string): Promise<InstallmentPlanDocument | null> {
    return this.planModel.findOne({ orderId: new Types.ObjectId(orderId) });
  }

  async findByCustomer(customerId: string): Promise<InstallmentPlanDocument[]> {
    return this.planModel.find({ customerId }).sort({ createdAt: -1 });
  }

  async findById(planId: string): Promise<InstallmentPlanDocument> {
    const plan = await this.planModel.findById(planId);
    if (!plan) throw new NotFoundException("InstallmentPlan not found");
    return plan;
  }
}
