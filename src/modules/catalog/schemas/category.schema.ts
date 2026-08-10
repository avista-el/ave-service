import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type CategoryDocument = Category & Document;

export class SubcategoryEmbedded {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) slug: string;
}

@Schema({ timestamps: true, collection: "categories" })
export class Category {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ default: "" })
  blurb: string;

  @Prop({ default: "" })
  imageUrl: string;

  @Prop({ type: String, default: null })
  parentId: string | null;

  @Prop({ type: [{ id: String, name: String, slug: String }], default: [] })
  subcategories: SubcategoryEmbedded[];

  @Prop({ default: 0 })
  sortOrder: number;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
// slug: unique index already created by unique: true in @Prop
// parentId: plain index (not expressible as sparse/compound via @Prop)
CategorySchema.index({ parentId: 1 });
