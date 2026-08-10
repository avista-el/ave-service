import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
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

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly config: ConfigService,
  ) {
    this.client = new MeiliSearch({
      host: this.config.get<string>("meilisearch.host", "http://localhost:7700"),
      apiKey: this.config.get<string>("meilisearch.apiKey"),
    });
  }

  // ─── Bootstrap: ensure index + settings on startup ───────────────────────

  async onModuleInit() {
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
        `Meilisearch not reachable on init — search will degrade gracefully. ${(err as Error).message}`,
      );
    }
  }

  // ─── Index a single product (called by CatalogModule on create/update) ───

  async indexProduct(product: ProductDocument): Promise<void> {
    const doc = this.toIndexDoc(product);
    await this.client.index(INDEX_NAME).addDocuments([doc], { primaryKey: "id" });
  }

  async deleteFromIndex(productId: string): Promise<void> {
    await this.client.index(INDEX_NAME).deleteDocument(productId);
  }

  // ─── Rebuild full index (admin action) ───────────────────────────────────

  async reindexAll(): Promise<{ enqueued: number }> {
    const products = (await this.productModel
      .find({ status: "active" })
      .lean<{ _id: Types.ObjectId; [key: string]: unknown }[]>()) as unknown as ProductDocument[];
    const docs = products.map((p) => this.toIndexDoc(p));
    await this.client.index(INDEX_NAME).addDocuments(docs, { primaryKey: "id" });
    this.logger.log(`Re-indexed ${docs.length} products`);
    return { enqueued: docs.length };
  }

  // ─── Search / faceted filter ──────────────────────────────────────────────

  async search(query: SearchQuery) {
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

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, query.limit ?? 20);

    try {
      const result = await this.client.index(INDEX_NAME).search(query.q ?? "", {
        filter: filter.join(" AND "),
        sort,
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
    } catch (err) {
      this.logger.warn(`Meilisearch search failed, falling back: ${(err as Error).message}`);
      return { items: [], total: 0, page, limit, query: query.q };
    }
  }

  // ─── Autosuggest (header search bar) ─────────────────────────────────────

  async suggest(q: string): Promise<{ title: string; slug: string; categoryName: string }[]> {
    if (!q || q.trim().length < 2) return [];
    try {
      const result = await this.client.index(INDEX_NAME).search(q, {
        limit: 8,
        filter: 'status = "active"',
        attributesToRetrieve: ["title", "slug", "categoryName", "brandName"],
      });
      return result.hits as { title: string; slug: string; categoryName: string }[];
    } catch {
      return [];
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private toIndexDoc(p: ProductDocument) {
    const available = p.stock - p.reserved;
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
      images: p.images.slice(0, 1),
      tags: p.tags,
      status: p.status,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      stockStatus: available <= 0 ? "out_of_stock" : available <= 5 ? "low_stock" : "in_stock",
      description: p.description?.slice(0, 500),
    };
  }
}
