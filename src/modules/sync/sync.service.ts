import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import slugify from "slugify";
import {
  SyncSource,
  SyncSourceDocument,
  SyncRun,
  SyncRunDocument,
  SyncRunFieldChange,
  SyncRunNewProduct,
} from "./schemas/sync.schema";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";
import { Brand, BrandDocument } from "../catalog/schemas/brand.schema";
import { Category, CategoryDocument } from "../catalog/schemas/category.schema";
import { InventoryService } from "../inventory/inventory.service";
import { AuditLogService } from "../audit-log/audit-log.service";

const CLEAR_MARKER = "CLEAR";

type LeanSyncSource = {
  _id: Types.ObjectId;
  name: string;
  sheetUrl: string;
  sheetId: string;
  columnMapping: Record<string, string>;
  schedule: "manual" | "hourly" | "daily";
  active: boolean;
  lastRunAt: Date | null;
  googleRefreshToken: string | null;
};

type LeanProduct = {
  _id: Types.ObjectId;
  sku: string;
  title: string;
  stock: number;
  reserved: number;
  [key: string]: unknown;
};

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectModel(SyncSource.name)
    private readonly sourceModel: Model<SyncSourceDocument>,
    @InjectModel(SyncRun.name)
    private readonly runModel: Model<SyncRunDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Brand.name)
    private readonly brandModel: Model<BrandDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    private readonly inventoryService: InventoryService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ─── SyncSource CRUD ──────────────────────────────────────────────────────

  async createSource(dto: {
    name: string;
    sheetUrl: string;
    sheetId: string;
    columnMapping: Record<string, string>;
    schedule?: "manual" | "hourly" | "daily";
  }): Promise<SyncSourceDocument> {
    return this.sourceModel.create(dto);
  }

  async findAllSources(): Promise<LeanSyncSource[]> {
    return this.sourceModel.find().sort({ createdAt: -1 }).lean<LeanSyncSource[]>();
  }

  async findSourceById(id: string): Promise<LeanSyncSource> {
    const src = await this.sourceModel.findById(id).lean<LeanSyncSource>();
    if (!src) throw new NotFoundException("Sync source not found");
    return src;
  }

  async updateSource(
    id: string,
    dto: Partial<{ name: string; columnMapping: Record<string, string>; schedule: string }>,
  ): Promise<SyncSourceDocument> {
    const src = await this.sourceModel.findByIdAndUpdate(id, dto, { new: true });
    if (!src) throw new NotFoundException("Sync source not found");
    return src;
  }

  // ─── Execute a sync run (validate + diff, write SyncRun, NO live writes) ──

  async executeRun(
    sourceId: string,
    triggeredBy: string,
    rows: Record<string, string>[],
  ): Promise<SyncRunDocument> {
    const source = await this.findSourceById(sourceId);
    const mapping = source.columnMapping;

    // ── Auto-detect mapping mode ───────────────────────────────────────────
    // Google Sheets mode: mapping values are column letters (A, B, C…).
    //   Row keys are whatever the sheet API returns — could be letters or headers.
    // CSV upload mode: rows are parsed with header names as keys (sku, title…).
    //   In this case we build an identity mapping so row["sku"] → field "sku".
    //
    // Detection: if the first non-empty row already has a key matching one of
    // the system field names directly, we're in CSV/header mode and should use
    // the system field key as the row key directly, ignoring the stored column
    // letter mapping.
    const firstRow = rows[0] ?? {};
    const systemFieldKeys = Object.keys(mapping); // e.g. ["sku", "title", "price_ngn", …]
    const rowKeys = Object.keys(firstRow);
    const csvHeaderMode = systemFieldKeys.some((k) => rowKeys.includes(k));

    // Build the effective lookup mapping:
    // csvHeaderMode → { "sku": "sku", "title": "title", … }  (identity)
    // sheetsMode    → { "sku": "A",   "title": "B",   … }   (column letters)
    const effectiveMapping: Record<string, string> = csvHeaderMode
      ? Object.fromEntries(systemFieldKeys.map((k) => [k, k]))
      : mapping;

    const updatedFields: SyncRunFieldChange[] = [];
    const newProducts: SyncRunNewProduct[] = [];
    const errors: Array<{ row: number; sku?: string; message: string }> = [];
    let unchangedCount = 0;

    const allSkus = new Set(
      rows
        .map((r) => r[effectiveMapping["sku"] ?? "sku"]?.trim().toUpperCase())
        .filter(Boolean) as string[],
    );

    const existingProducts = await this.productModel
      .find({ sku: { $in: Array.from(allSkus) } })
      .lean<LeanProduct[]>();

    const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));
    const sheetSkus = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 2;

      const sku = row[effectiveMapping["sku"] ?? "sku"]?.trim().toUpperCase();
      if (!sku) {
        errors.push({ row: rowNum, message: "SKU is missing or blank" });
        continue;
      }
      sheetSkus.add(sku);

      const existing = productBySku.get(sku);

      if (!existing) {
        const title = row[effectiveMapping["title"] ?? "title"] ?? "";

        // Price: try the mapped column first, then scan all known price aliases
        // directly in the row — handles CSVs where the column is named "price"
        // or "unit_price" instead of the template's "price_ngn".
        const priceAliases = ["price_ngn", "price", "unit_price", "selling_price", "amount"];
        let rawPrice: string | undefined;
        // 1. Try via mapping
        const mappedPriceKey = effectiveMapping["price_ngn"] ?? effectiveMapping["price"];
        if (mappedPriceKey) rawPrice = row[mappedPriceKey];
        // 2. Fall back to scanning the row directly for known aliases
        if (!rawPrice) {
          for (const alias of priceAliases) {
            if (row[alias] !== undefined && row[alias] !== "") {
              rawPrice = row[alias];
              break;
            }
          }
        }
        const price = rawPrice
          ? parseFloat(rawPrice.replace(/[₦,₵\s]/g, "").replace(/[^0-9.]/g, ""))
          : null;

        if (!title) {
          errors.push({ row: rowNum, sku, message: "New product missing required field: title" });
          continue;
        }
        if (price === null || isNaN(price)) {
          errors.push({
            row: rowNum,
            sku,
            message:
              `New product missing required field: price. ` +
              `Tried columns: ${priceAliases.join(", ")}. ` +
              `Available columns: ${Object.keys(row).join(", ")}`,
          });
          continue;
        }
        newProducts.push({ sku, fields: this.rowToFields(row, effectiveMapping) });
        continue;
      }

      const fields = this.rowToFields(row, effectiveMapping);
      let hasChange = false;

      for (const [field, rawValue] of Object.entries(fields)) {
        if (rawValue === null || rawValue === undefined || rawValue === "") continue;

        const isClear = rawValue === CLEAR_MARKER;
        const newValue = isClear ? null : rawValue;

        if (field === "stock") {
          const newStock = isClear ? 0 : Number(rawValue);
          if (isNaN(newStock)) {
            errors.push({
              row: rowNum,
              sku,
              message: `Stock value is not a number: "${rawValue}"`,
            });
            continue;
          }
          if (newStock !== existing.stock) {
            const conflict = newStock < existing.reserved;
            updatedFields.push({
              sku,
              productTitle: existing.title,
              field: "stock",
              oldValue: existing.stock,
              newValue: newStock,
              conflict,
            });
            if (conflict) {
              errors.push({
                row: rowNum,
                sku,
                message: `Stock ${newStock} is below reserved ${existing.reserved} — review required`,
              });
            }
            hasChange = true;
          }
          continue;
        }

        const oldValue = existing[field];
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          updatedFields.push({
            sku,
            productTitle: existing.title,
            field,
            oldValue,
            newValue,
            conflict: false,
          });
          hasChange = true;
        }
      }

      if (!hasChange) unchangedCount++;
    }

    const notInSheet = existingProducts
      .filter((p) => !sheetSkus.has(p.sku))
      .map((p) => ({ sku: p.sku, productTitle: p.title }));

    const run = await this.runModel.create({
      sourceId,
      status: "pending_review",
      triggeredBy,
      newProducts,
      updatedFields,
      unchangedCount,
      syncErrors: errors, // field renamed from `errors` (Mongoose reserved pathname)
      notInSheet,
    });

    await this.sourceModel.findByIdAndUpdate(sourceId, { lastRunAt: new Date() });

    return run;
  }

  // ─── Review & approve ─────────────────────────────────────────────────────

  async approveSyncRun(
    runId: string,
    selectedChanges: string[], // "<sku>:<field>" keys for existing-product updates
    actorId: string,
    selectedNewSkus: string[] = [], // SKUs from newProducts to create
  ): Promise<{ applied: number; created: number; skipped: number }> {
    const run = await this.runModel.findById(runId);
    if (!run) throw new NotFoundException("Sync run not found");
    if (!["pending_review", "partially_approved"].includes(run.status)) {
      throw new BadRequestException("Sync run is not in a reviewable state");
    }

    // ── 1. Apply field updates to existing products ────────────────────────
    const selectedSet = new Set(selectedChanges);
    const toApply = run.updatedFields.filter((c) => selectedSet.has(`${c.sku}:${c.field}`));

    const changesBySku = new Map<string, Record<string, unknown>>();
    for (const change of toApply) {
      if (!changesBySku.has(change.sku)) changesBySku.set(change.sku, {});
      changesBySku.get(change.sku)![change.field] = change.newValue;
    }

    let applied = 0;
    for (const [sku, patch] of changesBySku) {
      const product = await this.productModel.findOne({ sku });
      if (!product) continue;

      if ("stock" in patch) {
        const newStock = patch["stock"] as number;
        try {
          await this.inventoryService.setStock(
            (product._id as unknown as Types.ObjectId).toString(),
            newStock,
            `sync:${runId}`,
          );
        } catch (err) {
          this.logger.warn(`Stock update blocked for ${sku}: ${(err as Error).message}`);
        }
        delete patch["stock"];
      }

      if ("compareAtPrice" in patch) {
        const val = patch["compareAtPrice"];
        patch["compareAtPrice"] = val === null || val === "" ? null : Number(val);
      }

      if (Object.keys(patch).length > 0) {
        await this.productModel.findOneAndUpdate(
          { sku },
          { ...patch, lastModifiedBy: `sync:${runId}` },
        );
      }

      await this.auditLogService.log({
        actor: `admin:${actorId}`,
        action: "sync.approve",
        entityType: "product",
        entityId: (product._id as unknown as Types.ObjectId).toString(),
        before: null,
        after: patch,
        note: `SyncRun: ${runId}`,
      });

      applied++;
    }

    // ── 2. Create new products ─────────────────────────────────────────────
    const newSkuSet = new Set(selectedNewSkus.map((s) => s.toUpperCase()));
    const toCreate = run.newProducts.filter((p) => newSkuSet.has(p.sku.toUpperCase()));

    let created = 0;
    const creationErrors: string[] = [];

    // Cache brand + category lookups so we don't hit DB per product
    const brandCache = new Map<string, BrandDocument | null>();
    const categoryCache = new Map<string, CategoryDocument | null>();

    for (const np of toCreate) {
      const fields = np.fields as Record<string, unknown>;
      const sku = np.sku.trim().toUpperCase();
      const title = (fields["title"] as string | undefined)?.trim() ?? "";
      const price = Number(fields["price"]);

      if (!title || isNaN(price) || price <= 0) {
        creationErrors.push(`${sku}: missing title or price`);
        continue;
      }

      // ── Resolve brand ─────────────────────────────────────────────────────
      const brandName = (fields["brand"] as string | undefined)?.trim();
      let brand: BrandDocument | null = null;

      if (brandName) {
        const cacheKey = brandName.toLowerCase();
        if (!brandCache.has(cacheKey)) {
          const found = await this.brandModel.findOne({
            $or: [
              { name: { $regex: new RegExp(`^${brandName}$`, "i") } },
              { slug: slugify(brandName, { lower: true, strict: true }) },
            ],
          });
          brandCache.set(cacheKey, found as BrandDocument | null);
        }
        brand = brandCache.get(cacheKey) ?? null;

        // Auto-create brand if it doesn't exist
        if (!brand) {
          const slug = slugify(brandName, { lower: true, strict: true });
          brand = (await this.brandModel.create({
            name: brandName,
            slug,
            logoUrl: "",
          })) as BrandDocument;
          brandCache.set(cacheKey, brand);
          this.logger.log(`Sync: auto-created brand "${brandName}"`);
        }
      }

      if (!brand) {
        creationErrors.push(`${sku}: could not resolve brand "${brandName ?? "not provided"}"`);
        continue;
      }

      // ── Resolve category ──────────────────────────────────────────────────
      const categorySlugOrName = (fields["category"] as string | undefined)?.trim();
      let category: CategoryDocument | null = null;

      if (categorySlugOrName) {
        const cacheKey = categorySlugOrName.toLowerCase();
        if (!categoryCache.has(cacheKey)) {
          const found = await this.categoryModel.findOne({
            $or: [
              { slug: categorySlugOrName.toLowerCase() },
              { name: { $regex: new RegExp(`^${categorySlugOrName}$`, "i") } },
            ],
          });
          categoryCache.set(cacheKey, found as CategoryDocument | null);
        }
        category = categoryCache.get(cacheKey) ?? null;
      }

      // Fall back to first available category if none matched
      if (!category) {
        if (!categoryCache.has("__default__")) {
          const first = await this.categoryModel.findOne().sort({ sortOrder: 1 });
          categoryCache.set("__default__", first as CategoryDocument | null);
        }
        category = categoryCache.get("__default__") ?? null;
        if (categorySlugOrName) {
          this.logger.warn(
            `Sync: category "${categorySlugOrName}" not found for SKU ${sku}, using default`,
          );
        }
      }

      if (!category) {
        creationErrors.push(`${sku}: no category available`);
        continue;
      }

      // ── Resolve subcategory ───────────────────────────────────────────────
      const subcategorySlug = (fields["subcategory"] as string | undefined)?.trim();
      const subcategory = subcategorySlug
        ? category.subcategories?.find(
            (s) =>
              s.slug === subcategorySlug.toLowerCase() ||
              s.name?.toLowerCase() === subcategorySlug.toLowerCase(),
          )
        : undefined;

      // ── Build slug ────────────────────────────────────────────────────────
      let slug = slugify(`${brand.name} ${title}`, { lower: true, strict: true });
      const slugExists = await this.productModel.exists({ slug });
      if (slugExists) slug = `${slug}-${sku.toLowerCase()}`;

      // ── Create the product ────────────────────────────────────────────────
      try {
        const doc = await this.productModel.create({
          sku,
          slug,
          title: `${brand.name} ${title}`,
          brandId: (brand._id as unknown as Types.ObjectId).toString(),
          brandName: brand.name,
          brandSlug: (brand as unknown as Record<string, unknown>).slug as string,
          categoryId: (category._id as unknown as Types.ObjectId).toString(),
          categoryName: category.name,
          categorySlug: (category as unknown as Record<string, unknown>).slug as string,
          subcategoryId: subcategory?.id ?? null,
          subcategoryName: subcategory?.name ?? null,
          subcategorySlug: subcategory?.slug ?? null,
          price: price,
          compareAtPrice:
            fields["compareAtPrice"] != null ? Number(fields["compareAtPrice"]) : null,
          stock: fields["stock"] != null ? parseInt(String(fields["stock"]), 10) : 0,
          reserved: 0,
          images: Array.isArray(fields["images"]) ? fields["images"] : [],
          description: (fields["description"] as string | undefined) ?? "",
          descriptionHtml: "",
          specs: [],
          status: (fields["status"] as string | undefined) ?? "draft",
          tags: Array.isArray(fields["tags"]) ? fields["tags"] : [],
          lastModifiedBy: `sync:${runId}`,
        });

        await this.auditLogService.log({
          actor: `admin:${actorId}`,
          action: "product.create",
          entityType: "product",
          entityId: (doc._id as unknown as Types.ObjectId).toString(),
          before: null,
          after: { sku, source: "sync" },
          note: `SyncRun: ${runId}`,
        });

        created++;
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`Sync: failed to create ${sku}: ${msg}`);
        creationErrors.push(`${sku}: ${msg}`);
      }
    }

    if (creationErrors.length) {
      this.logger.warn(`Sync run ${runId}: ${creationErrors.length} creation error(s)`);
    }

    const skipped = toApply.length - applied;
    run.status = applied > 0 || created > 0 ? "published" : "partially_approved";
    run.reviewedBy = actorId;
    run.reviewedAt = new Date();
    await run.save();

    return { applied, created, skipped };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async findAllRuns(sourceId?: string) {
    const filter = sourceId ? { sourceId } : {};
    return this.runModel.find(filter).sort({ createdAt: -1 }).limit(50).lean();
  }

  async findRunById(id: string): Promise<SyncRunDocument> {
    const run = await this.runModel.findById(id);
    if (!run) throw new NotFoundException("Sync run not found");
    return run;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private rowToFields(
    row: Record<string, string>,
    mapping: Record<string, string>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Full field map: system field name → internal field name stored in result
    // Aliases cover both the template column names and common alternatives
    const fieldMap: Record<string, string> = {
      // Core updatable fields
      title: "title",
      price: "price",
      price_ngn: "price", // template alias
      unit_price: "price", // user alias
      selling_price: "price", // user alias
      compare_at: "compareAtPrice",
      compare_at_ngn: "compareAtPrice", // template alias
      compare_price: "compareAtPrice", // user alias
      stock: "stock",
      stock_qty: "stock", // template alias
      quantity: "stock", // user alias
      description: "description",
      images: "images",
      image_urls: "images", // template alias
      status: "status",
      tags: "tags",
      // Informational fields — stored as metadata on the new-product record
      // so admins can see what brand/category was intended; not written to
      // product.brandId/categoryId directly (those require ObjectId lookups)
      brand: "brand",
      brand_name: "brand", // user alias
      category: "category",
      category_name: "category", // user alias
      subcategory: "subcategory",
      subcategory_name: "subcategory", // user alias
    };

    for (const [systemField, colName] of Object.entries(mapping)) {
      const schemaField = fieldMap[systemField];
      if (!schemaField) continue;

      // Look up by the column name (could be a letter from Sheets or a header from CSV)
      const raw = row[colName] ?? row[systemField];
      if (raw === undefined || raw === null || raw === "") continue;

      this.applyField(result, schemaField, raw);
    }

    // Also scan the row directly for any unaliased columns that match known field names
    // This handles CSVs where the user didn't configure a mapping but has standard headers
    for (const [rowKey, raw] of Object.entries(row)) {
      if (!raw) continue;
      const schemaField = fieldMap[rowKey.toLowerCase().replace(/\s+/g, "_")];
      if (schemaField && !(schemaField in result)) {
        this.applyField(result, schemaField, raw);
      }
    }

    return result;
  }

  /** Apply a single raw value to the result object using field-appropriate logic */
  private applyField(result: Record<string, unknown>, schemaField: string, raw: string): void {
    switch (schemaField) {
      case "price":
      case "compareAtPrice": {
        const cleaned = raw.replace(/[₦,₵\s]/g, "").replace(/[^0-9.]/g, "");
        const num = parseFloat(cleaned);
        if (!isNaN(num)) result[schemaField] = num;
        break;
      }
      case "stock": {
        const num = parseInt(raw.replace(/[^0-9]/g, ""), 10);
        result["stock"] = isNaN(num) ? raw : String(num);
        break;
      }
      case "images": {
        const urls = raw
          .split(/[,\n]/)
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length) result["images"] = urls;
        break;
      }
      case "tags": {
        const validTags = ["new_arrival", "best_seller", "featured", "deal"];
        const tags = raw
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter((t) => validTags.includes(t));
        if (tags.length) result["tags"] = tags;
        break;
      }
      default:
        result[schemaField] = raw.trim();
    }
  }
}
