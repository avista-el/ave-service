import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export type InstallmentPlanStatus = "active" | "completed" | "defaulted" | "cancelled";
export type ScheduleEntryStatus = "pending" | "paid" | "failed" | "overdue";
export type InstallmentPlanDocument = InstallmentPlan & Document;

/**
 * One entry in the repayment schedule.
 * Three of these are created at deposit time, one per monthly instalment.
 */
export class ScheduleEntry {
  /** 1-based instalment number (1, 2, 3) */
  installmentNumber: number;
  dueDate: Date;
  /** NGN amount due — same for all three in the current product (totalRepayable / 3) */
  amount: number;
  status: ScheduleEntryStatus;
  paidAt: Date | null;
  /** How many charge attempts have been made for this entry */
  attemptCount: number;
  lastAttemptAt: Date | null;
  /** Paystack/Flutterwave reference returned when the charge succeeds */
  paymentReference: string | null;
}

/**
 * BNPL instalment plan.
 *
 * Business rules (hardcoded in service; stored here for audit):
 *   deposit      = 40% of cashPrice
 *   balance      = 60% of cashPrice
 *   interest     = 10% flat on balance (not compounding)
 *   instalments  = 3 equal monthly payments of (balance + interest) / 3
 *   total cost   = cashPrice × 1.06
 *
 * Forfeiture on cancellation / default:
 *   proactive cancel (customer-initiated, no missed payment) → 5% of amountPaidToDate
 *   default (missed payment after retries exhausted)         → 10% of amountPaidToDate
 */
@Schema({ timestamps: true, collection: "installment_plans" })
export class InstallmentPlan {
  @Prop({ type: Types.ObjectId, ref: "Order", required: true, index: true })
  orderId: Types.ObjectId;

  @Prop({ required: true })
  customerId: string;

  /** The full cash price of the order (order.total before this plan was created) */
  @Prop({ required: true, min: 0 })
  cashPrice: number;

  /** 40% of cashPrice — charged at checkout */
  @Prop({ required: true, min: 0 })
  depositAmount: number;

  /** 60% of cashPrice */
  @Prop({ required: true, min: 0 })
  balancePrincipal: number;

  @Prop({ required: true, default: 0.1 })
  interestRate: number;

  /** interestRate × balancePrincipal */
  @Prop({ required: true, min: 0 })
  interestAmount: number;

  /** balancePrincipal + interestAmount */
  @Prop({ required: true, min: 0 })
  totalRepayable: number;

  /** totalRepayable / numberOfInstallments */
  @Prop({ required: true, min: 0 })
  installmentAmount: number;

  @Prop({ required: true, default: 3 })
  numberOfInstallments: number;

  @Prop({ required: true, default: "monthly" })
  frequency: string;

  /** Running total of all amounts received (deposit + paid instalments) */
  @Prop({ required: true, default: 0, min: 0 })
  amountPaidToDate: number;

  @Prop({
    type: [
      {
        installmentNumber: { type: Number, required: true },
        dueDate: { type: Date, required: true },
        amount: { type: Number, required: true },
        status: {
          type: String,
          enum: ["pending", "paid", "failed", "overdue"],
          default: "pending",
        },
        paidAt: { type: Date, default: null },
        attemptCount: { type: Number, default: 0 },
        lastAttemptAt: { type: Date, default: null },
        paymentReference: { type: String, default: null },
      },
    ],
    default: [],
  })
  schedule: ScheduleEntry[];

  /**
   * The saved card token used to charge subsequent instalments.
   * Paystack calls this authorization_code; Flutterwave calls it token.
   */
  @Prop({ required: true })
  authorizationCode: string;

  @Prop({ type: String, enum: ["paystack", "flutterwave"], required: true })
  provider: "paystack" | "flutterwave";

  @Prop({
    type: String,
    enum: ["active", "completed", "defaulted", "cancelled"],
    default: "active",
  })
  status: InstallmentPlanStatus;

  @Prop({ type: Date, default: null })
  defaultedAt: Date | null;

  /**
   * 0.05 for proactive cancellation, 0.10 for post-default.
   * Set at the time forfeiture is triggered.
   */
  @Prop({ type: Number, default: null })
  forfeitRate: number | null;

  @Prop({ type: Number, default: null })
  forfeitAmount: number | null;
}

export const InstallmentPlanSchema = SchemaFactory.createForClass(InstallmentPlan);
InstallmentPlanSchema.index({ orderId: 1 });
InstallmentPlanSchema.index({ customerId: 1, status: 1 });
// Used by the daily default-scan cron to find overdue active plans efficiently
InstallmentPlanSchema.index({ "schedule.dueDate": 1, status: 1 });
