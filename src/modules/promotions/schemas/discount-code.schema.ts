import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type DiscountCodeDocument = DiscountCode & Document;

@Schema({ timestamps: true, collection: "discount_codes" })
export class DiscountCode {
  @Prop({ required: true, unique: true, uppercase: true, trim: true })
  code: string;

  @Prop({ required: true, enum: ["percent", "fixed"] })
  type: "percent" | "fixed";

  @Prop({ required: true, min: 0 })
  value: number;

  @Prop({ type: Number, default: null })
  minOrderAmount: number | null;

  @Prop({ required: true })
  startsAt: Date;

  @Prop({ required: true })
  endsAt: Date;

  @Prop({ type: Number, default: null })
  usageLimit: number | null;

  @Prop({ default: 0 })
  usedCount: number;

  @Prop({ type: String, default: "all", enum: ["all", "category", "product"] })
  scope: "all" | "category" | "product";

  @Prop({ type: [String], default: [] })
  targets: string[];

  @Prop({ default: true })
  active: boolean;
}

export const DiscountCodeSchema = SchemaFactory.createForClass(DiscountCode);
// code: unique index already created by unique: true in @Prop
// Compound index for active code lookups by date range:
DiscountCodeSchema.index({ active: 1, startsAt: 1, endsAt: 1 });
