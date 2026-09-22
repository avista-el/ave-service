import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export type DiscountCodeDocument = DiscountCode & Document;

// ─── Discount type for the discount amount computation ────────────────────────
export type DiscountType = "percent" | "fixed";

// ─── Application scope ────────────────────────────────────────────────────────
export type ApplicationScope = "product" | "category" | "catalogue";

/**
 * A single admin-side auto-apply binding.
 *
 * Separates the admin "push discount to scope" audit trail from the customer
 * coupon redemption trail (`usedCount`). They answer different questions:
 *   - redemptions → "who used a code and when?"
 *   - applications → "what is discounted right now and why?"
 *
 * Precedence (most-specific wins, first match, NO stacking):
 *   product → category → catalogue
 */
export class CampaignApplication {
  _id: Types.ObjectId;

  /** Granularity of the binding. */
  scope: ApplicationScope;

  /**
   * The entity being targeted:
   *   - scope=product   → product ObjectId (as string)
   *   - scope=category  → categorySlug string
   *   - scope=catalogue → null (applies to everything)
   */
  targetId: string | null;

  /** Admin user who created this application. */
  appliedBy: string;

  appliedAt: Date;

  /** Can be toggled without deleting the record. */
  active: boolean;
}

@Schema({ timestamps: true, collection: "discount_codes" })
export class DiscountCode {
  @Prop({ required: true, unique: true, uppercase: true, trim: true })
  code: string;

  @Prop({ required: true, enum: ["percent", "fixed"] })
  type: DiscountType;

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

  /**
   * Admin-side auto-apply bindings.  Kept separate from customer redemptions
   * so they can be reported and audited independently.
   */
  @Prop({
    type: [
      {
        scope: { type: String, enum: ["product", "category", "catalogue"], required: true },
        targetId: { type: String, default: null },
        appliedBy: { type: String, required: true },
        appliedAt: { type: Date, required: true },
        active: { type: Boolean, default: true },
      },
    ],
    default: [],
  })
  applications: CampaignApplication[];
}

export const DiscountCodeSchema = SchemaFactory.createForClass(DiscountCode);
// code: unique index already created by unique: true in @Prop
// Compound index for active code lookups by date range:
DiscountCodeSchema.index({ active: 1, startsAt: 1, endsAt: 1 });
// Lookup active applications efficiently:
DiscountCodeSchema.index({ "applications.scope": 1, "applications.active": 1 });
