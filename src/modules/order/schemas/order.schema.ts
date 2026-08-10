import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type OrderStatus =
  "pending_payment" | "paid" | "failed" | "abandoned" | "fulfilled" | "cancelled" | "refunded";

export type PaymentProvider = "paystack" | "flutterwave";
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

  /** null for guest checkout — explicit type required to avoid CannotDetermineTypeError */
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
    enum: ["pending_payment", "paid", "failed", "abandoned", "fulfilled", "cancelled", "refunded"],
    default: "pending_payment",
  })
  status: OrderStatus;

  @Prop({ type: String, enum: ["paystack", "flutterwave"], required: true })
  paymentProvider: PaymentProvider;

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
// orderNumber   — unique index already created by unique: true in @Prop
// paymentReference — index already created by index: true in @Prop
// customerId    — index already created by index: true in @Prop
// These compound indexes are not expressible via @Prop, so they stay here:
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ customerId: 1, createdAt: -1 });
