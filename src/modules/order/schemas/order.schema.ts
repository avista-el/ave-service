import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "failed"
  | "abandoned"
  | "fulfilled"
  | "cancelled"
  | "refunded"
  | "refund_required" // late payment arrived after stock released — needs manual refund
  | "awaiting_delivery_payment" // POD: order placed, cash/POS not yet collected
  | "in_installments"; // BNPL: deposit paid, balance still being collected

export type PaymentProvider = "paystack" | "flutterwave";

export type PaymentMethod = "paystack" | "flutterwave" | "pay_on_delivery" | "installment";

export type AttemptStatus = "INITIATED" | "SUCCESS" | "FAILED";

/**
 * Maps a raw gateway decline code to a customer-safe failure code.
 * UNKNOWN is the catch-all.
 */
export type FailureCode =
  "DECLINED" | "INSUFFICIENT_FUNDS" | "TIMEOUT" | "CANCELLED_BY_USER" | "UNKNOWN";

export type OrderDocument = Order & Document;

// ─── Embedded sub-documents ───────────────────────────────────────────────────

export class OrderLineEmbedded {
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) sku: string;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) image: string;
  @Prop({ required: true, min: 1 }) qty: number;
  @Prop({ required: true, min: 0 }) unitPrice: number;
}

export class AddressEmbedded {
  @Prop({ required: true }) fullName: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true }) line1: string;
  @Prop({ default: "" }) line2: string;
  @Prop({ required: true }) city: string;
  @Prop({ required: true }) state: string;
  @Prop({ default: "Nigeria" }) country: string;
}

/**
 * One hashed guest-access token stored on the order.
 * Raw tokens are NEVER persisted — only the SHA-256 hex digest is stored.
 * Up to 10 most-recent tokens are kept; older ones are pruned on each issue.
 */
export class AccessTokenEmbedded {
  /** SHA-256 hex digest of the raw token */
  @Prop({ required: true }) hash: string;
  /** 30 days from issue */
  @Prop({ required: true }) expiresAt: Date;
}

/**
 * One payment attempt record.  Created at initializePayment time and updated
 * when the gateway webhook or verify call returns a final outcome.
 */
export class PaymentAttemptEmbedded {
  /** The paymentReference used for this specific attempt (may differ on retry) */
  @Prop({ required: true }) reference: string;
  @Prop({ type: String, enum: ["paystack", "flutterwave"], required: true })
  provider: "paystack" | "flutterwave";
  @Prop({ type: String, enum: ["INITIATED", "SUCCESS", "FAILED"], default: "INITIATED" })
  status: AttemptStatus;
  /**
   * Customer-safe failure code mapped from the raw gateway decline reason.
   * Only set when status === 'FAILED'.
   */
  @Prop({
    type: String,
    enum: ["DECLINED", "INSUFFICIENT_FUNDS", "TIMEOUT", "CANCELLED_BY_USER", "UNKNOWN"],
    default: null,
  })
  failureCode: FailureCode | null;
  /** Raw message from the gateway — stored for ops debugging, never sent to customers */
  @Prop({ type: String, default: null }) rawFailureReason: string | null;
  @Prop({ required: true }) createdAt: Date;
}

// ─── Main schema ──────────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: "orders", toJSON: { virtuals: true } })
export class Order {
  @Prop({ required: true, unique: true })
  orderNumber: string;

  @Prop({ type: String, default: null, index: true })
  customerId: string | null;

  @Prop({ type: String, default: null })
  customerEmail: string | null;

  @Prop({ type: String, default: null })
  customerName: string | null;

  @Prop({ type: [Object], default: [] })
  items: OrderLineEmbedded[];

  @Prop({ required: true, min: 0 })
  subtotal: number;

  @Prop({ type: String, default: null })
  promoCode: string | null;

  @Prop({ default: 0 })
  discountAmount: number;

  @Prop({ required: true, min: 0 })
  total: number;

  @Prop({ default: "NGN" })
  currency: string;

  @Prop({
    type: String,
    enum: [
      "pending_payment",
      "paid",
      "failed",
      "abandoned",
      "fulfilled",
      "cancelled",
      "refunded",
      "refund_required",
      "awaiting_delivery_payment",
      "in_installments",
    ],
    default: "pending_payment",
  })
  status: OrderStatus;

  @Prop({
    type: String,
    enum: ["paystack", "flutterwave", "pay_on_delivery", "installment"],
    required: true,
  })
  paymentMethod: PaymentMethod;

  @Prop({
    type: String,
    enum: ["paystack", "flutterwave", null],
    default: null,
  })
  paymentProvider: PaymentProvider | null;

  /** Primary reference — stays constant for the lifetime of the order */
  @Prop({ required: true, index: true })
  paymentReference: string;

  @Prop({ type: String, default: null })
  checkoutUrl: string | null;

  @Prop({ type: Object, required: true })
  shippingAddress: AddressEmbedded;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  @Prop({ type: Date, default: null })
  fulfilledAt: Date | null;

  @Prop({ type: String, default: null })
  processedWebhookId: string | null;

  // ── Guest access tokens (new) ───────────────────────────────────────────

  /**
   * Up to 10 hashed guest-access tokens.  Each email that generates a link
   * gets its own token.  Raw tokens are never stored here.
   */
  @Prop({
    type: [
      {
        hash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
      },
    ],
    default: [],
  })
  accessTokens: AccessTokenEmbedded[];

  // ── Payment attempts (new) ──────────────────────────────────────────────

  /**
   * Chronological list of gateway payment attempts.
   * First entry created when initializePayment is called.
   * Subsequent entries added on retry.
   * Indexed on `reference` for fast webhook/verify lookup.
   */
  @Prop({
    type: [
      {
        reference: { type: String, required: true },
        provider: { type: String, enum: ["paystack", "flutterwave"], required: true },
        status: { type: String, enum: ["INITIATED", "SUCCESS", "FAILED"], default: "INITIATED" },
        failureCode: {
          type: String,
          enum: ["DECLINED", "INSUFFICIENT_FUNDS", "TIMEOUT", "CANCELLED_BY_USER", "UNKNOWN"],
          default: null,
        },
        rawFailureReason: { type: String, default: null },
        createdAt: { type: Date, required: true },
      },
    ],
    default: [],
  })
  paymentAttempts: PaymentAttemptEmbedded[];

  /**
   * When the stock reservation for this order expires.
   * Set to now + ORDER_HOLD_MINUTES at order creation for gateway orders.
   * Extended by ORDER_HOLD_MINUTES on each successful retry initiation.
   * null for POD orders (no expiry until 5-day cancellation).
   */
  @Prop({ type: Date, default: null, index: true })
  reservationExpiresAt: Date | null;

  // ── Cancellation request (new) ──────────────────────────────────────────

  /**
   * Set by the customer or guest via POST /orders/:orderNumber/cancel for
   * paid orders (which cannot be auto-cancelled).  Admin must process manually.
   */
  @Prop({ type: Date, default: null })
  cancellationRequestedAt: Date | null;

  @Prop({ type: String, default: null })
  cancellationReason: string | null;

  // ── Sent-emails idempotency map (new) ───────────────────────────────────

  /**
   * Records the first sentAt time for each email type.
   * Keys: "order_confirmed" | "payment_failed" | "order_expired" |
   *        "order_cancelled" | "refund_required" | "track_link"
   * Used to prevent duplicate emails (e.g. multiple failed webhooks).
   */
  @Prop({ type: Map, of: Date, default: {} })
  sentEmails: Map<string, Date>;

  // ── Admin review flag (new) ─────────────────────────────────────────────

  /**
   * Set to true when a payment amount or currency mismatch is detected.
   * Surfaces the order in admin for manual review; does NOT block other processing.
   */
  @Prop({ type: Boolean, default: false })
  needsAmountReview: boolean;
}

export const ORDER_STATUS_ENUM = [
  "pending_payment",
  "paid",
  "failed",
  "abandoned",
  "fulfilled",
  "cancelled",
  "refunded",
  "refund_required",
  "awaiting_delivery_payment",
  "in_installments",
] as const;

/** Maximum number of access tokens retained per order */
export const ACCESS_TOKEN_MAX_STORED = 10;

export const OrderSchema = SchemaFactory.createForClass(Order);

// ── Indexes ──────────────────────────────────────────────────────────────────
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ customerId: 1, createdAt: -1 });
// Fast lookup for the stale-reservation expiry job:
OrderSchema.index({ reservationExpiresAt: 1, status: 1 });
// Fast lookup of an order by any attempt's reference (webhook + retry dedup):
OrderSchema.index({ "paymentAttempts.reference": 1 }, { sparse: true });
// Admin filter for cancellation-requested orders:
OrderSchema.index({ cancellationRequestedAt: 1 }, { sparse: true });
// Admin filter for amount-review orders:
OrderSchema.index({ needsAmountReview: 1, status: 1 }, { sparse: true });
