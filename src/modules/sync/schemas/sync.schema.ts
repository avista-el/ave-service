import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

// ─── SyncSource ───────────────────────────────────────────────────────────────

export type SyncSourceDocument = SyncSource & Document;

@Schema({ timestamps: true, collection: "sync_sources" })
export class SyncSource {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) sheetUrl: string;
  @Prop({ required: true }) sheetId: string;
  @Prop({ type: Object, default: {} }) columnMapping: Record<string, string>;
  @Prop({ type: String, default: "manual", enum: ["manual", "hourly", "daily"] })
  schedule: "manual" | "hourly" | "daily";
  @Prop({ default: true }) active: boolean;
  @Prop({ type: Date, default: null }) lastRunAt: Date | null;
  @Prop({ type: String, default: null }) googleRefreshToken: string | null;
}

export const SyncSourceSchema = SchemaFactory.createForClass(SyncSource);

// ─── SyncRun ──────────────────────────────────────────────────────────────────

export type SyncRunDocument = SyncRun & Document;

export class SyncRunFieldChange {
  sku: string;
  productTitle: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  conflict?: boolean;
}

export class SyncRunError {
  row: number;
  sku?: string;
  message: string;
}

export class SyncRunNewProduct {
  sku: string;
  fields: Record<string, unknown>;
}

export class SyncRunNotInSheet {
  sku: string;
  productTitle: string;
}

@Schema({ timestamps: true, collection: "sync_runs" })
export class SyncRun {
  @Prop({ required: true }) sourceId: string;
  @Prop({
    type: String,
    required: true,
    enum: ["pending_review", "partially_approved", "published", "failed"],
    default: "pending_review",
  })
  status: "pending_review" | "partially_approved" | "published" | "failed";
  @Prop({ default: "manual" }) triggeredBy: string;
  @Prop({ type: [Object], default: [] }) newProducts: SyncRunNewProduct[];
  @Prop({ type: [Object], default: [] }) updatedFields: SyncRunFieldChange[];
  @Prop({ default: 0 }) unchangedCount: number;
  /** Renamed from `errors` — that name is reserved by Mongoose and causes a warning. */
  @Prop({ type: [Object], default: [] }) syncErrors: SyncRunError[];
  @Prop({ type: [Object], default: [] }) notInSheet: SyncRunNotInSheet[];
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) publishNote: string | null;
}

export const SyncRunSchema = SchemaFactory.createForClass(SyncRun);
SyncRunSchema.index({ sourceId: 1, createdAt: -1 });
SyncRunSchema.index({ status: 1 });
