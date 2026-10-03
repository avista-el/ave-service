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
  | "awaiting_delivery_payment" // POD: order placed, cash/POS not yet collected
  | "in_installments"; // BNPL: deposit paid, balance still being collected

export type PaymentProvider = "paystack" | "flutterwave";

/**
 * How the customer is paying.
 *   paystack / flutterwave — full upfront payment via gateway
 *   pay_on_delivery        — cash or POS at the door; no gateway involved at checkout
 *   installment            — 40% deposit via gateway, 60% over 3 monthly instalments
 */
export type PaymentMethod = "paystack" | "flutterwave" | "pay_on_delivery" | "installment";

export type OrderDocument = Order & Document;

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

@Schema({ timestamps: true, collection: "orders" })
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
      "awaiting_delivery_payment",
      "in_installments",
    ],
    default: "pending_payment",
  })
  status: OrderStatus;

  /**
   * Which payment channel the customer chose.
   * Replaces / extends the former `paymentProvider` field:
   *   - "paystack" | "flutterwave"  → full gateway payment (same as before)
   *   - "pay_on_delivery"           → POD; no gateway redirect
   *   - "installment"               → BNPL; gateway used only for deposit
   */
  @Prop({
    type: String,
    enum: ["paystack", "flutterwave", "pay_on_delivery", "installment"],
    required: true,
  })
  paymentMethod: PaymentMethod;

  /**
   * Kept for backward compat with PaymentModule webhook handlers that
   * still need to know which gateway handled the charge (null for POD).
   */
  @Prop({
    type: String,
    enum: ["paystack", "flutterwave", null],
    default: null,
  })
  paymentProvider: PaymentProvider | null;

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
}

export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ customerId: 1, createdAt: -1 });
