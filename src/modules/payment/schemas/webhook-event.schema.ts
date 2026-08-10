import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type WebhookEventDocument = WebhookEvent & Document;

/**
 * Idempotency store for provider webhooks.
 * A unique index on eventId prevents double-processing on retries.
 */
@Schema({ timestamps: true, collection: "webhook_events" })
export class WebhookEvent {
  @Prop({ type: String, required: true, enum: ["paystack", "flutterwave"] })
  provider: "paystack" | "flutterwave";

  /** Provider's unique event ID — the unique index lives here */
  @Prop({ required: true, unique: true })
  eventId: string;

  @Prop({ required: true })
  type: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ required: true })
  processedAt: Date;
}

export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);
// eventId: unique index already created by unique: true in @Prop
// Compound index for provider + time queries:
WebhookEventSchema.index({ provider: 1, createdAt: -1 });
