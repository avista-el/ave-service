import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { MeiliSearch } from "meilisearch";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";
import {
  PriceResolutionService,
  type ResolvableProduct,
} from "../promotions/price-resolution.service";
import { LOW_STOCK_THRESHOLD } from "../../config/constants";

const INDEX_NAME = "products";

export interface SearchQuery {
  q?: string;
  categorySlug?: string;
  subcategorySlug?: string;
  brands?: string; // comma-separated slugs
  min?: number;
  max?: number;
  inStock?: boolean;
  rating?: number;
  sort?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  private readonly client: MeiliSearch;
  /** Set to false after the first Meilisearch failure so we stop retrying */
  private meiliAvailable = true;
  /** Tracks whether the MongoDB text index was created successfully */
  private textIndexAvailable = false;

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly priceResolution: PriceResolutionService,
    private readonly config: ConfigService,
  ) {
    const host = this.config.get<string>("meilisearch.host", "http://localhost:7700");
    const apiKey = this.config.get<string>("meilisearch.apiKey");

    this.client = new MeiliSearch({
      host,
      ...(apiKey ? { apiKey } : {}),
    });

    if (!apiKey) {
      this.logger.warn(
        "MEILISEARCH_API_KEY is not set — search will use MongoDB fallback. " +
          "Set the master key (or a search-only key) to enable Meilisearch.",
      );
      this.meiliAvailable = false;
    }
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  async onModuleInit() {
    // Ensure MongoDB text index exists for the fallback search path.
    // This is a no-op if the index already exists.
    try {
      await this.productModel.collection.createIndex(
        {
          title: "text",
          brandName: "text",
          categoryName: "text",
          description: "text",
          sku: "text",
        },
        { name: "product_text_search", default_language: "english" },
      );
      this.textIndexAvailable = true;
    } catch {
      // Index already exists — still safe to use
      this.textIndexAvailable = true;
    }

    if (!this.meiliAvailable) return;

    try {
      const index = this.client.index(INDEX_NAME);
      await index.updateSettings({
        searchableAttributes: [
          "title",
          "brandName",
          "categoryName",
          "subcategoryName",
          "description",
          "sku",
        ],
        filterableAttributes: [
          "categorySlug",
          "subcategorySlug",
          "brandSlug",
          "tags",
          "status",
          "price",
          "ratingAvg",
          "stockStatus",
        ],
        sortableAttributes: ["price", "ratingAvg", "ratingCount", "createdAt"],
        displayedAttributes: [
          "id",
          "slug",
          "title",
          "brandName",
          "brandSlug",
          "categoryName",
          "categorySlug",
          "subcategoryName",
          "subcategorySlug",
          "price",
          "compareAtPrice",
          "images",
          "stockStatus",
          "ratingAvg",
          "ratingCount",
          "tags",
          "sku",
        ],
        typoTolerance: { enabled: true },
      });
      this.logger.log("Meilisearch index configured");
    } catch (err) {
      this.logger.warn(
        `Meilisearch not reachable on init — falling back to MongoDB for all searches. ` +
          `Error: ${(err as Error).message}`,
      );
      this.meiliAvailable = false;
    }
  }

  // ─── Index a single product ───────────────────────────────────────────────

  async indexProduct(product: ProductDocument): Promise<void> {
    if (!this.meiliAvailable) return;
    try {
      const doc = this.toIndexDoc(product);
      await this.client.index(INDEX_NAME).addDocuments([doc], { primaryKey: "id" });
    } catch (err) {
      this.logger.warn(`Failed to index product ${product.sku}: ${(err as Error).message}`);
    }
  }

  async deleteFromIndex(productId: string): Promise<void> {
    if (!this.meiliAvailable) return;
    try {
      await this.client.index(INDEX_NAME).deleteDocument(productId);
    } catch (err) {
      this.logger.warn(`Failed to remove ${productId} from index: ${(err as Error).message}`);
    }
  }

  // ─── Rebuild full index ───────────────────────────────────────────────────

  async reindexAll(): Promise<{ enqueued: number }> {
    const products = (await this.productModel
      .find({ status: "active" })
      .lean<{ _id: Types.ObjectId; [key: string]: unknown }[]>()) as unknown as ProductDocument[];
    const docs = products.map((p) => this.toIndexDoc(p));

    if (this.meiliAvailable) {
      try {
        await this.client.index(INDEX_NAME).addDocuments(docs, { primaryKey: "id" });
        this.logger.log(`Re-indexed ${docs.length} products in Meilisearch`);
      } catch (err) {
        this.logger.error(`Meilisearch reindex failed: ${(err as Error).message}`);
        this.meiliAvailable = false;
      }
    }

    return { enqueued: docs.length };
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async search(query: SearchQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);

    // Try Meilisearch first; fall back to MongoDB on any failure or empty result
    if (this.meiliAvailable) {
      try {
        const result = await this.meiliSearch(query, page, limit);
        // If Meilisearch returned hits, use them
        if (result.items.length > 0 || !query.q) {
          // Resolve effective prices for all hits in a single batch call
          result.items = await this.resolvePrices(result.items);
          return result;
        }
        // Zero hits with a query term → try MongoDB in case the index is stale
        this.logger.debug(`Meilisearch returned 0 hits for "${query.q}" — trying MongoDB fallback`);
      } catch (err) {
        this.logger.error(
          `Meilisearch search error (falling back to MongoDB): ${(err as Error).message}`,
        );
        this.meiliAvailable = false;
      }
    }

    const result = await this.mongoSearch(query, page, limit);
    // Resolve effective prices for all hits in a single batch call
    result.items = await this.resolvePrices(result.items);
    return result;
  }

  // ─── Autosuggest ─────────────────────────────────────────────────────────

  async suggest(q: string): Promise<{ title: string; slug: string; categoryName: string }[]> {
    if (!q || q.trim().length < 2) return [];

    if (this.meiliAvailable) {
      try {
        const result = await this.client.index(INDEX_NAME).search(q, {
          limit: 8,
          filter: 'status = "active"',
          attributesToRetrieve: ["title", "slug", "categoryName", "brandName"],
        });
        if (result.hits.length > 0) {
          return result.hits as { title: string; slug: string; categoryName: string }[];
        }
        // Fall through to MongoDB if Meilisearch returned nothing
      } catch (err) {
        this.logger.error(`Meilisearch suggest error: ${(err as Error).message}`);
        this.meiliAvailable = false;
      }
    }

    // MongoDB fallback suggest
    return this.mongoSuggest(q);
  }

  // ─── Meilisearch implementation ───────────────────────────────────────────

  private async meiliSearch(query: SearchQuery, page: number, limit: number) {
    const filter: string[] = ['status = "active"'];

    if (query.categorySlug) filter.push(`categorySlug = "${query.categorySlug}"`);
    if (query.subcategorySlug) filter.push(`subcategorySlug = "${query.subcategorySlug}"`);
    if (query.brands) {
      const slugs = query.brands.split(",").map((s) => `brandSlug = "${s.trim()}"`);
      filter.push(`(${slugs.join(" OR ")})`);
    }
    if (query.min !== undefined) filter.push(`price >= ${query.min}`);
    if (query.max !== undefined) filter.push(`price <= ${query.max}`);
    if (query.inStock) filter.push('stockStatus != "out_of_stock"');
    if (query.rating !== undefined) filter.push(`ratingAvg >= ${query.rating}`);

    const sortMap: Record<string, string> = {
      price_asc: "price:asc",
      price_desc: "price:desc",
      newest: "createdAt:desc",
      best_selling: "ratingCount:desc",
      rating: "ratingAvg:desc",
    };
    const sort = query.sort && sortMap[query.sort] ? [sortMap[query.sort]] : undefined;

    const result = await this.client.index(INDEX_NAME).search(query.q ?? "", {
      filter: filter.join(" AND "),
      ...(sort ? { sort } : {}),
      offset: (page - 1) * limit,
      limit,
      attributesToHighlight: ["title"],
    });

    return {
      items: result.hits.map((h) => this.toApiShape(h as Record<string, unknown>)),
      total: result.estimatedTotalHits ?? 0,
      page,
      limit,
      query: query.q,
    };
  }

  // ─── MongoDB fallback search ──────────────────────────────────────────────

  private async mongoSearch(query: SearchQuery, page: number, limit: number) {
    const filter: FilterQuery<ProductDocument> = { status: "active" };

    if (query.q?.trim()) {
      const term = query.q.trim();
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // $text must be a top-level operator — it cannot appear inside $or.
      // Use it directly when the text index is available (always true on Atlas
      // because onModuleInit ensures the index exists).
      // Fall back to a pure regex $or only when $text would fail (e.g. the
      // collection has no text index yet on a brand-new deployment).
      if (this.textIndexAvailable) {
        filter.$text = { $search: term };
      } else {
        filter.$or = [
          { title: { $regex: escaped, $options: "i" } },
          { brandName: { $regex: escaped, $options: "i" } },
          { categoryName: { $regex: escaped, $options: "i" } },
          { sku: { $regex: escaped, $options: "i" } },
        ];
      }
    }

    if (query.categorySlug) filter.categorySlug = query.categorySlug;
    if (query.subcategorySlug) filter.subcategorySlug = query.subcategorySlug;
    if (query.brands) {
      filter.brandSlug = { $in: query.brands.split(",").map((s) => s.trim()) };
    }
    if (query.min !== undefined || query.max !== undefined) {
      filter.price = {};
      if (query.min !== undefined) filter.price.$gte = query.min;
      if (query.max !== undefined) filter.price.$lte = query.max;
    }
    if (query.inStock) {
      filter.$expr = { $gt: [{ $subtract: ["$stock", "$reserved"] }, 0] };
    }
    if (query.rating !== undefined) filter.ratingAvg = { $gte: query.rating };

    const sortMap: Record<string, Record<string, 1 | -1>> = {
      price_asc: { price: 1 },
      price_desc: { price: -1 },
      newest: { createdAt: -1 },
      best_selling: { ratingCount: -1 },
      rating: { ratingAvg: -1 },
    };
    const sort: Record<string, 1 | -1> =
      query.sort && sortMap[query.sort] ? sortMap[query.sort]! : { ratingCount: -1 };

    const [items, total] = await Promise.all([
      this.productModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<ProductDocument[]>(),
      this.productModel.countDocuments(filter),
    ]);

    const hits = items.map((p) =>
      this.toApiShape(this.toIndexDoc(p as unknown as ProductDocument) as Record<string, unknown>),
    );

    return { items: hits, total, page, limit, query: query.q };
  }

  // ─── MongoDB fallback suggest ─────────────────────────────────────────────

  private async mongoSuggest(
    q: string,
  ): Promise<{ title: string; slug: string; categoryName: string }[]> {
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.productModel
      .find({
        status: "active",
        $or: [
          { title: { $regex: escaped, $options: "i" } },
          { brandName: { $regex: escaped, $options: "i" } },
          { sku: { $regex: escaped, $options: "i" } },
        ],
      })
      .select("title slug categoryName")
      .limit(8)
      .lean<{ title: string; slug: string; categoryName: string }[]>();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private toIndexDoc(p: ProductDocument) {
    const available = (p.stock ?? 0) - (p.reserved ?? 0);
    const stockStatus =
      available <= 0 ? "out_of_stock" : available <= LOW_STOCK_THRESHOLD ? "low_stock" : "in_stock";

    return {
      id: (p._id as unknown as Types.ObjectId).toString(),
      slug: p.slug,
      sku: p.sku,
      title: p.title,
      brandName: p.brandName,
      brandSlug: p.brandSlug,
      categoryName: p.categoryName,
      categorySlug: p.categorySlug,
      subcategoryName: p.subcategoryName,
      subcategorySlug: p.subcategorySlug,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      images: p.images?.slice(0, 1) ?? [],
      tags: p.tags ?? [],
      status: p.status,
      ratingAvg: p.ratingAvg ?? 0,
      ratingCount: p.ratingCount ?? 0,
      stockStatus,
      description: p.description?.slice(0, 500) ?? "",
    };
  }

  // ─── Batch price resolution (called after results are fetched) ──────────

  /**
   * Resolves effectivePrice and autoAppliedDiscount for all search results
   * using a SINGLE PriceResolutionService.resolveEffectivePriceBatch call.
   *
   * The search index (Meilisearch) and the Mongo fallback both store the
   * raw base `price` — never the effective (discounted) price. Discounts are
   * resolved at read time so they stay live without re-indexing.
   *
   * LIMITATION: price filters (min/max) and price sorting (price_asc/desc)
   * operate on the base price, not the effective price. This means a product
   * priced at ₦100,000 with a 20% auto-apply discount (effective ₦80,000) will
   * still be filtered/sorted as ₦100,000 in search. This is acceptable because
   * auto-apply campaigns change frequently and re-indexing on every change
   * would be expensive. The product page and cart always show the resolved
   * effective price.
   */
  private async resolvePrices<
    T extends {
      id: string;
      priceBase: number;
      effectivePrice: number;
      autoAppliedDiscount: unknown;
    },
  >(items: T[]): Promise<T[]> {
    if (items.length === 0) return items;

    // 1. Collect product IDs from the search hits
    const ids = items.map((i) => i.id);

    // 2. Load pricing-relevant fields in a single query
    const products = await this.productModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select("price categorySlug subcategorySlug")
      .lean<
        {
          _id: Types.ObjectId;
          price: number;
          categorySlug: string;
          subcategorySlug: string | null;
        }[]
      >();

    // 3. Build the ResolvableProduct array for batch resolution
    const resolvables: ResolvableProduct[] = products.map((p) => ({
      _id: p._id,
      price: p.price,
      categorySlug: p.categorySlug,
      subcategorySlug: p.subcategorySlug ?? undefined,
    }));

    // 4. Resolve all prices in a single batch call (one DB query for campaigns)
    const resolved = await this.priceResolution.resolveEffectivePriceBatch(resolvables);

    // 5. Patch each item with the resolved effectivePrice and autoAppliedDiscount
    for (const item of items) {
      const r = resolved.get(item.id);
      if (r) {
        item.effectivePrice = r.effectivePrice;
        (item as Record<string, unknown>)["autoAppliedDiscount"] = r.appliedCampaign
          ? {
              campaignId: r.appliedCampaign.campaignId,
              code: r.appliedCampaign.code,
              type: r.appliedCampaign.type,
              value: r.appliedCampaign.value,
              source: r.appliedCampaign.source,
            }
          : null;
      }
    }

    return items;
  }

  /**
   * Reshape a search hit (either from Meilisearch or from toIndexDoc) into
   * the ApiProduct-compatible shape the frontend expects.
   *
   * The search index stores flat fields (ratingAvg, ratingCount, price, etc.)
   * while the catalog API returns nested objects (rating.average, rating.count,
   * priceBase, effectivePrice, …).  Both paths must produce the same shape so
   * the frontend's toProduct() adapter works everywhere.
   */
  toApiShape(hit: Record<string, unknown>) {
    return {
      id: hit["id"] as string,
      slug: hit["slug"] as string,
      sku: (hit["sku"] as string | undefined) ?? "",
      title: hit["title"] as string,
      brand: {
        id: (hit["brandId"] as string | undefined) ?? "",
        name: (hit["brandName"] as string | undefined) ?? "",
        slug: (hit["brandSlug"] as string | undefined) ?? "",
      },
      category: {
        id: (hit["categoryId"] as string | undefined) ?? "",
        name: (hit["categoryName"] as string | undefined) ?? "",
        slug: (hit["categorySlug"] as string | undefined) ?? "",
      },
      subcategory: hit["subcategorySlug"]
        ? {
            id: (hit["subcategoryId"] as string | undefined) ?? "",
            name: (hit["subcategoryName"] as string | undefined) ?? "",
            slug: hit["subcategorySlug"] as string,
          }
        : undefined,
      priceBase: (hit["price"] as number | undefined) ?? 0,
      compareAtPrice: (hit["compareAtPrice"] as number | null | undefined) ?? undefined,
      // Default: effectivePrice = priceBase. The caller (search method) patches
      // this field via resolvePrices() after batch auto-apply resolution.
      effectivePrice: (hit["price"] as number | undefined) ?? 0,
      autoAppliedDiscount: null,
      images: (hit["images"] as string[] | undefined) ?? [],
      specs: [],
      description: (hit["description"] as string | undefined) ?? "",
      stockStatus: (hit["stockStatus"] as string | undefined) ?? "in_stock",
      rating: {
        average: (hit["ratingAvg"] as number | undefined) ?? 0,
        count: (hit["ratingCount"] as number | undefined) ?? 0,
      },
      tags: (hit["tags"] as string[] | undefined) ?? [],
      status: (hit["status"] as string | undefined) ?? "active",
    };
  }
}
