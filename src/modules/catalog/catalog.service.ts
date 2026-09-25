import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, FilterQuery, SortOrder, Types } from "mongoose";
import slugify from "slugify";
import { Product, ProductDocument, ProductTag } from "./schemas/product.schema";
import { Brand, BrandDocument } from "./schemas/brand.schema";
import { Category, CategoryDocument } from "./schemas/category.schema";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { QueryProductsDto, SortKey } from "./dto/query-products.dto";
import { CreateBrandDto } from "./dto/create-brand.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { paginate, PaginatedResult } from "../../common/dto/pagination.dto";
import { PriceResolutionService, ResolvableProduct } from "../promotions/price-resolution.service";

// Use plain lean types to avoid FlattenMaps<Document> incompatibility
type LeanProduct = Omit<ProductDocument, keyof Document> & { _id: Types.ObjectId };
type LeanBrand = Omit<BrandDocument, keyof Document> & { _id: Types.ObjectId };
type LeanCategory = Omit<CategoryDocument, keyof Document> & { _id: Types.ObjectId };

@Injectable()
export class CatalogService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Brand.name) private readonly brandModel: Model<BrandDocument>,
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    private readonly priceResolution: PriceResolutionService,
  ) {}

  // ─── Products ────────────────────────────────────────────────────────────────

  async createProduct(dto: CreateProductDto, actorId: string): Promise<ProductDocument> {
    const sku = dto.sku.trim().toUpperCase();
    const exists = await this.productModel.exists({ sku });
    if (exists) throw new ConflictException(`SKU ${sku} already exists`);

    const brand = await this.brandModel.findById(dto.brandId).lean();
    if (!brand) throw new NotFoundException("Brand not found");

    const category = await this.categoryModel.findById(dto.categoryId).lean();
    if (!category) throw new NotFoundException("Category not found");

    const subcategory = dto.subcategoryId
      ? category.subcategories?.find((s) => s.id === dto.subcategoryId)
      : null;

    const slug = this.makeSlug(`${brand.name} ${dto.title}`);

    return this.productModel.create({
      ...dto,
      sku,
      slug,
      brandName: brand.name,
      brandSlug: brand.slug,
      categoryName: category.name,
      categorySlug: category.slug,
      subcategoryId: subcategory?.id ?? null,
      subcategoryName: subcategory?.name ?? null,
      subcategorySlug: subcategory?.slug ?? null,
      stock: dto.stock ?? 0,
      lastModifiedBy: `admin:${actorId}`,
    });
  }

  async findAllProducts(
    query: QueryProductsDto,
    adminMode = false,
  ): Promise<PaginatedResult<ReturnType<CatalogService["toProductResponse"]>>> {
    const filter: FilterQuery<ProductDocument> = {};

    if (!adminMode) {
      filter.status = "active";
    } else if (query.status) {
      filter.status = query.status;
    }

    if (query.categorySlug) filter.categorySlug = query.categorySlug;
    if (query.subcategorySlug) filter.subcategorySlug = query.subcategorySlug;
    if (query.tag) filter.tags = query.tag;

    if (query.brands) {
      const slugs = query.brands.split(",").map((s) => s.trim());
      filter.brandSlug = { $in: slugs };
    }

    if (query.min !== undefined || query.max !== undefined) {
      filter.price = {};
      if (query.min !== undefined) filter.price.$gte = query.min;
      if (query.max !== undefined) filter.price.$lte = query.max;
    }

    if (query.inStock) {
      filter.$expr = { $gt: [{ $subtract: ["$stock", "$reserved"] }, 0] };
    }

    if (query.rating !== undefined) {
      filter.ratingAvg = { $gte: query.rating };
    }

    if (query.q) {
      filter.$text = { $search: query.q };
    }

    const sortMap: Record<SortKey, Record<string, SortOrder>> = {
      featured: { tags: -1, createdAt: -1 },
      price_asc: { price: 1 },
      price_desc: { price: -1 },
      newest: { createdAt: -1 },
      best_selling: { ratingCount: -1 },
      rating: { ratingAvg: -1 },
    };
    const sort = sortMap[query.sort ?? "featured"];

    const [raw, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort(sort)
        .skip(query.skip)
        .limit(query.limit ?? 20)
        .lean<LeanProduct[]>(),
      this.productModel.countDocuments(filter),
    ]);

    // Resolve effective prices for the whole page in one DB round-trip.
    const priceMap = await this.priceResolution.resolveEffectivePriceBatch(raw.map(toResolvable));

    const items = raw.map((p) => this.toProductResponse(p, priceMap.get(p._id.toString())));

    return paginate(items, total, query);
  }

  async findProductBySlug(slug: string): Promise<ReturnType<CatalogService["toProductResponse"]>> {
    const product = await this.productModel.findOne({ slug }).lean<LeanProduct>();
    if (!product) throw new NotFoundException("Product not found");
    const resolved = await this.priceResolution.resolveEffectivePrice(toResolvable(product));
    return this.toProductResponse(product, resolved);
  }

  async findProductById(id: string): Promise<LeanProduct> {
    const product = await this.productModel.findById(id).lean<LeanProduct>();
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  async findProductBySku(sku: string): Promise<LeanProduct | null> {
    return this.productModel.findOne({ sku: sku.toUpperCase() }).lean<LeanProduct>();
  }

  async updateProduct(
    id: string,
    dto: UpdateProductDto,
    actorId: string,
  ): Promise<ProductDocument> {
    const product = await this.productModel.findById(id);
    if (!product) throw new NotFoundException("Product not found");

    if (dto.brandId && dto.brandId !== product.brandId) {
      const brand = await this.brandModel.findById(dto.brandId).lean();
      if (!brand) throw new NotFoundException("Brand not found");
      (dto as Record<string, unknown>).brandName = brand.name;
      (dto as Record<string, unknown>).brandSlug = brand.slug;
    }

    // Resolve new category denorm fields when categoryId changes.
    const resolvedCategoryId = dto.categoryId ?? product.categoryId;
    if (dto.categoryId && dto.categoryId !== product.categoryId) {
      const category = await this.categoryModel.findById(dto.categoryId).lean();
      if (!category) throw new NotFoundException("Category not found");
      (dto as Record<string, unknown>).categoryName = category.name;
      (dto as Record<string, unknown>).categorySlug = category.slug;
    }

    // Resolve subcategory denorm fields whenever subcategoryId is supplied.
    // We must do this even if only subcategoryId changed (not categoryId),
    // because the stored name/slug would otherwise be stale.
    if ("subcategoryId" in dto) {
      if (!dto.subcategoryId) {
        // Explicitly clearing the subcategory
        (dto as Record<string, unknown>).subcategoryName = null;
        (dto as Record<string, unknown>).subcategorySlug = null;
      } else {
        const category = await this.categoryModel.findById(resolvedCategoryId).lean();
        const sub = category?.subcategories?.find(
          (s: { id: string; name: string; slug: string }) => s.id === dto.subcategoryId,
        );
        if (sub) {
          (dto as Record<string, unknown>).subcategoryName = sub.name;
          (dto as Record<string, unknown>).subcategorySlug = sub.slug;
        }
      }
    }

    const updated = await this.productModel.findByIdAndUpdate(
      id,
      { ...dto, lastModifiedBy: `admin:${actorId}` },
      { new: true },
    );
    if (!updated) throw new NotFoundException("Product not found");
    return updated;
  }

  async deleteProduct(id: string): Promise<void> {
    const result = await this.productModel.findByIdAndUpdate(id, { status: "archived" });
    if (!result) throw new NotFoundException("Product not found");
  }

  async toggleTag(id: string, tag: ProductTag, actorId: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id);
    if (!product) throw new NotFoundException("Product not found");

    const hasTag = product.tags.includes(tag);
    const updated = await this.productModel.findByIdAndUpdate(
      id,
      hasTag
        ? { $pull: { tags: tag }, lastModifiedBy: `admin:${actorId}` }
        : { $addToSet: { tags: tag }, lastModifiedBy: `admin:${actorId}` },
      { new: true },
    );
    return updated!;
  }

  async getSimilarProducts(
    productId: string,
    limit = 8,
  ): Promise<ReturnType<CatalogService["toProductResponse"]>[]> {
    const product = await this.productModel.findById(productId).lean();
    if (!product) return [];
    const raw = await this.productModel
      .find({ _id: { $ne: productId }, categorySlug: product.categorySlug, status: "active" })
      .limit(limit)
      .lean<LeanProduct[]>();

    const priceMap = await this.priceResolution.resolveEffectivePriceBatch(raw.map(toResolvable));
    return raw.map((p) => this.toProductResponse(p, priceMap.get(p._id.toString())));
  }

  // ─── Brands ──────────────────────────────────────────────────────────────────

  async createBrand(dto: CreateBrandDto): Promise<BrandDocument> {
    const slug = this.makeSlug(dto.name);
    const exists = await this.brandModel.exists({ slug });
    if (exists) throw new ConflictException("Brand slug already exists");
    return this.brandModel.create({ name: dto.name, slug, logoUrl: dto.logoUrl ?? "" });
  }

  async findAllBrands(): Promise<LeanBrand[]> {
    return this.brandModel.find().sort({ name: 1 }).lean<LeanBrand[]>();
  }

  async findBrandById(id: string): Promise<LeanBrand> {
    const brand = await this.brandModel.findById(id).lean<LeanBrand>();
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  async updateBrand(id: string, dto: Partial<CreateBrandDto>): Promise<BrandDocument> {
    const brand = await this.brandModel.findByIdAndUpdate(id, dto, { new: true });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  async deleteBrand(id: string): Promise<void> {
    const result = await this.brandModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException("Brand not found");
  }

  // ─── Categories ──────────────────────────────────────────────────────────────

  async createCategory(dto: CreateCategoryDto): Promise<CategoryDocument> {
    const slug = this.makeSlug(dto.name);
    const exists = await this.categoryModel.exists({ slug });
    if (exists) throw new ConflictException("Category slug already exists");
    return this.categoryModel.create({ ...dto, slug });
  }

  async findAllCategories(): Promise<LeanCategory[]> {
    return this.categoryModel
      .find({ parentId: null })
      .sort({ sortOrder: 1, name: 1 })
      .lean<LeanCategory[]>();
  }

  async findCategoryBySlug(slug: string): Promise<LeanCategory> {
    const cat = await this.categoryModel.findOne({ slug }).lean<LeanCategory>();
    if (!cat) throw new NotFoundException("Category not found");
    return cat;
  }

  async updateCategory(id: string, dto: Partial<CreateCategoryDto>): Promise<CategoryDocument> {
    const cat = await this.categoryModel.findByIdAndUpdate(id, dto, { new: true });
    if (!cat) throw new NotFoundException("Category not found");
    return cat;
  }

  async deleteCategory(id: string): Promise<void> {
    const result = await this.categoryModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException("Category not found");
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  makeSlug(value: string): string {
    return slugify(value, { lower: true, strict: true, trim: true });
  }

  /**
   * Build the API response shape for a product.
   *
   * `resolved` is optional — admin endpoints that don't need storefront pricing
   * (e.g. raw product edit) can call this without it and get priceBase only.
   *
   * When `resolved` is provided:
   *   - `effectivePrice` is the discounted price customers pay.
   *   - `autoAppliedDiscount` carries the campaign info for the storefront
   *     "X% off — applied automatically" badge. null when no auto-apply matches.
   */
  toProductResponse(
    doc: LeanProduct | ProductDocument,
    resolved?: import("../promotions/price-resolution.service").ResolvedPrice,
  ) {
    const id = (doc._id as unknown as Types.ObjectId).toString();
    const stockStatus = this.computeStockStatus((doc.stock ?? 0) - (doc.reserved ?? 0));
    const d = doc as Record<string, unknown>;
    return {
      id,
      slug: d["slug"] as string,
      title: d["title"] as string,
      brand: { id: d["brandId"], name: d["brandName"], slug: d["brandSlug"] },
      category: { id: d["categoryId"], name: d["categoryName"], slug: d["categorySlug"] },
      subcategory: d["subcategoryId"]
        ? { id: d["subcategoryId"], name: d["subcategoryName"], slug: d["subcategorySlug"] }
        : undefined,
      priceBase: d["price"] as number,
      compareAtPrice: (d["compareAtPrice"] as number | null) ?? undefined,
      // effectivePrice === priceBase when no discount is active.
      effectivePrice: resolved?.effectivePrice ?? (d["price"] as number),
      autoAppliedDiscount: resolved?.appliedCampaign ?? null,
      images: d["images"] as string[],
      specs: d["specs"] as { label: string; value: string }[],
      description: d["description"] as string,
      descriptionHtml: d["descriptionHtml"] as string | undefined,
      stockStatus,
      rating: { average: d["ratingAvg"] as number, count: d["ratingCount"] as number },
      tags: d["tags"] as string[],
      sku: d["sku"] as string,
      stock: d["stock"] as number,
      reserved: d["reserved"] as number,
      status: d["status"] as string,
    };
  }

  computeStockStatus(available: number): "in_stock" | "low_stock" | "out_of_stock" | "preorder" {
    if (available <= 0) return "out_of_stock";
    if (available <= 5) return "low_stock";
    return "in_stock";
  }
}

// ─── Module-level helper ─────────────────────────────────────────────────────

/**
 * Map a lean product document to the narrow ResolvableProduct shape that
 * PriceResolutionService needs. Defined outside the class so it can be
 * used in both instance methods and any future static contexts.
 */
function toResolvable(p: LeanProduct): ResolvableProduct {
  const d = p as Record<string, unknown>;
  return {
    _id: p._id,
    price: d["price"] as number,
    categorySlug: d["categorySlug"] as string,
    subcategorySlug: (d["subcategorySlug"] as string | null) ?? undefined,
  };
}
