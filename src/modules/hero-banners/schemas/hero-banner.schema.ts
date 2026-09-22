import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type HeroBannerDocument = HeroBanner & Document;

@Schema({ timestamps: true, collection: "hero_banners" })
export class HeroBanner {
  @Prop({ required: true, trim: true })
  headline: string;

  @Prop({ default: "" })
  subline: string;

  /** Cloudinary URL for the banner image */
  @Prop({ default: "" })
  image: string;

  /** Destination link when the CTA button is clicked */
  @Prop({ default: "/shop" })
  link: string;

  /** ISO-8601 date string, e.g. "2026-09-01" */
  @Prop({ default: "" })
  startsAt: string;

  /** ISO-8601 date string, e.g. "2026-09-30" */
  @Prop({ default: "" })
  endsAt: string;

  @Prop({ default: false })
  active: boolean;

  /** Used to control display order in the carousel */
  @Prop({ default: 0 })
  sortOrder: number;
}

export const HeroBannerSchema = SchemaFactory.createForClass(HeroBanner);
HeroBannerSchema.index({ active: 1, sortOrder: 1 });
