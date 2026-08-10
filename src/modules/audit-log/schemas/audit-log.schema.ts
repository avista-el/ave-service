import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type AuditLogDocument = AuditLog & Document;

@Schema({ timestamps: false, collection: "audit_logs" })
export class AuditLog {
  /**
   * actor format:
   *   admin:<userId>       — admin user action
   *   sync:<syncRunId>     — sync module commit
   *   system               — automated job
   *   customer:<userId>    — customer self-service
   */
  @Prop({ required: true, index: true })
  actor: string;

  /** e.g. "product.update", "order.refund", "sync.approve" */
  @Prop({ required: true })
  action: string;

  @Prop({ required: true })
  entityType: string;

  @Prop({ required: true })
  entityId: string;

  @Prop({ type: Object, default: null })
  before: Record<string, unknown> | null;

  @Prop({ type: Object, default: null })
  after: Record<string, unknown> | null;

  @Prop({ type: String, default: null })
  note: string | null;

  @Prop({ required: true, default: () => new Date() })
  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
// action, entityType, entityId: single-field indexes already created by index: true in @Prop.
// Compound indexes can't be expressed via @Prop, so they live here:
AuditLogSchema.index({ entityType: 1, entityId: 1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });
