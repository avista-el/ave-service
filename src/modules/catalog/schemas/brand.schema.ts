import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type BrandDocument = Brand & Document;

@Schema({ timestamps: true, collection: "brands" })
export class Brand {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  /** Cloudinary URL */
  @Prop({ default: "" })
  logoUrl: string;
}

export const BrandSchema = SchemaFactory.createForClass(Brand);
// slug: unique index already created by unique: true in @Prop
