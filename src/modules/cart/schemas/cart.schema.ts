import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type CartDocument = Cart & Document;

export class CartLineEmbedded {
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) sku: string;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) image: string;
  @Prop({ required: true, min: 0 }) unitPrice: number;
  @Prop({ required: true, min: 1 }) quantity: number;
}

@Schema({ timestamps: true, collection: "carts" })
export class Cart {
  @Prop({ type: String, default: null })
  userId: string | null;

  @Prop({ type: String, default: null })
  guestId: string | null;

  @Prop({ type: [Object], default: [] })
  lines: CartLineEmbedded[];

  @Prop({ type: String, default: null })
  promoCode: string | null;

  @Prop({ type: Number, default: null })
  discountAmount: number | null;

  /** TTL — abandoned carts expire after 14 days */
  @Prop({ type: Date, index: { expireAfterSeconds: 60 * 60 * 24 * 14 } })
  expiresAt: Date;
}

export const CartSchema = SchemaFactory.createForClass(Cart);
// Sparse indexes — null userId/guestId values don't consume index space.
// @Prop index: true was removed from both fields to avoid duplicates.
CartSchema.index({ userId: 1 }, { sparse: true });
CartSchema.index({ guestId: 1 }, { sparse: true });
