import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock" | "preorder";
export type ProductTag = "new_arrival" | "best_seller" | "featured" | "deal";
export type ProductStatus = "active" | "draft" | "archived";
export type ProductDocument = Product & Document;

@Schema({ timestamps: true, collection: "products" })
export class Product {
  @Prop({ required: true, unique: true, trim: true })
  sku: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true })
  brandId: string;

  @Prop({ required: true })
  brandName: string;

  @Prop({ required: true })
  brandSlug: string;

  @Prop({ required: true })
  categoryId: string;

  @Prop({ required: true })
  categoryName: string;

  @Prop({ required: true })
  categorySlug: string;

  @Prop({ type: String, default: null })
  subcategoryId: string | null;

  @Prop({ type: String, default: null })
  subcategoryName: string | null;

  @Prop({ type: String, default: null })
  subcategorySlug: string | null;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ type: Number, default: null })
  compareAtPrice: number | null;

  @Prop({ default: 0, min: 0 })
  stock: number;

  @Prop({ default: 0, min: 0 })
  reserved: number;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ default: "" })
  description: string;

  @Prop({ default: "" })
  descriptionHtml: string;

  @Prop({ type: [{ label: String, value: String }], default: [] })
  specs: { label: string; value: string }[];

  @Prop({ type: String, enum: ["active", "draft", "archived"], default: "draft" })
  status: ProductStatus;

  @Prop({ type: [String], enum: ["new_arrival", "best_seller", "featured", "deal"], default: [] })
  tags: ProductTag[];

  @Prop({ default: 0 })
  ratingAvg: number;

  @Prop({ default: 0 })
  ratingCount: number;

  @Prop({ type: String, default: null })
  lastModifiedBy: string | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
// sku and slug: unique indexes already created by unique: true in @Prop
// Compound and non-unique indexes that @Prop can't express:
ProductSchema.index({ categorySlug: 1, status: 1 });
ProductSchema.index({ subcategorySlug: 1, status: 1 });
ProductSchema.index({ brandSlug: 1, status: 1 });
ProductSchema.index({ tags: 1, status: 1 });
ProductSchema.index({ price: 1 });
ProductSchema.index({ status: 1 });
