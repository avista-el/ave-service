import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type FxRateDocument = FxRate & Document;

@Schema({ timestamps: true, collection: "fx_rates" })
export class FxRate {
  @Prop({ required: true, unique: true, uppercase: true })
  currency: string;

  @Prop({ required: true })
  rate: number;

  @Prop({ required: true })
  refreshedAt: Date;

  @Prop({ default: "manual" })
  source: string;
}

export const FxRateSchema = SchemaFactory.createForClass(FxRate);
// currency: unique index already created by unique: true in @Prop
