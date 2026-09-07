import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { MeiliSearch } from "meilisearch";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";

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

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
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
    } catch {
      // Index already exists — safe to ignore
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
        if (result.items.length > 0 || !query.q) return result;
        // Zero hits with a query term → try MongoDB in case the index is stale
        this.logger.debug(`Meilisearch returned 0 hits for "${query.q}" — trying MongoDB fallback`);
      } catch (err) {
        this.logger.error(
          `Meilisearch search error (falling back to MongoDB): ${(err as Error).message}`,
        );
        this.meiliAvailable = false;
      }
    }

    return this.mongoSearch(query, page, limit);
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
      items: result.hits,
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
      const escaped = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Use $text if the text index is available, fall back to $regex
      filter.$or = [
        { $text: { $search: query.q } } as FilterQuery<ProductDocument>,
        { title: { $regex: escaped, $options: "i" } },
        { brandName: { $regex: escaped, $options: "i" } },
        { categoryName: { $regex: escaped, $options: "i" } },
        { sku: { $regex: escaped, $options: "i" } },
      ];
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

    // Shape to match the Meilisearch hit format the frontend expects
    const hits = items.map((p) => this.toIndexDoc(p as unknown as ProductDocument));

    return { items: hits, total, page, limit, query: query.q };
  }

  // ─── MongoDB fallback suggest ─────────────────────────────────────────────

  private async mongoSuggest(
    q: string,
  ): Promise<{ title: string; slug: string; categoryName: string }[]> {
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const items = await this.productModel
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

    return items;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private toIndexDoc(p: ProductDocument) {
    const available = (p.stock ?? 0) - (p.reserved ?? 0);
    const stockStatus = available <= 0 ? "out_of_stock" : available <= 5 ? "low_stock" : "in_stock";

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
}
