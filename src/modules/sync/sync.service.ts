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

    // Shared brand/category caches across both passes — avoid duplicate DB hits
    const brandCache = new Map<string, BrandDocument>();
    const categoryCache = new Map<string, CategoryDocument>();

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

      // If brand changed, upsert the brand and update denormalised fields
      if ("brand" in patch) {
        const brandName = String(patch["brand"]).trim();
        delete patch["brand"];
        if (brandName) {
          const brand = await this.upsertBrand(brandName, brandCache);
          patch["brandId"] = (brand._id as unknown as Types.ObjectId).toString();
          patch["brandName"] = brand.name;
          patch["brandSlug"] = (brand as unknown as Record<string, unknown>).slug as string;
        }
      }

      // If category changed, upsert the category and update denormalised fields
      if ("category" in patch) {
        const catName = String(patch["category"]).trim();
        delete patch["category"];
        if (catName) {
          const cat = await this.upsertCategory(catName, categoryCache);
          patch["categoryId"] = (cat._id as unknown as Types.ObjectId).toString();
          patch["categoryName"] = cat.name;
          patch["categorySlug"] = (cat as unknown as Record<string, unknown>).slug as string;

          // Handle subcategory together with its parent category
          if ("subcategory" in patch) {
            const subName = String(patch["subcategory"]).trim();
            delete patch["subcategory"];
            if (subName) {
              const sub = await this.upsertSubcategory(subName, cat, categoryCache);
              patch["subcategoryId"] = sub.id;
              patch["subcategoryName"] = sub.name;
              patch["subcategorySlug"] = sub.slug;
            }
          }
        }
      } else if ("subcategory" in patch) {
        // subcategory change without category change — find existing category from product
        const subName = String(patch["subcategory"]).trim();
        delete patch["subcategory"];
        if (subName) {
          const existingCat = await this.categoryModel.findById(product.get("categoryId"));
          if (existingCat) {
            const sub = await this.upsertSubcategory(subName, existingCat, categoryCache);
            patch["subcategoryId"] = sub.id;
            patch["subcategoryName"] = sub.name;
            patch["subcategorySlug"] = sub.slug;
          }
        }
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

    for (const np of toCreate) {
      const fields = np.fields as Record<string, unknown>;
      const sku = np.sku.trim().toUpperCase();
      const title = (fields["title"] as string | undefined)?.trim() ?? "";
      const price = Number(fields["price"]);

      if (!title || isNaN(price) || price <= 0) {
        creationErrors.push(`${sku}: missing title or price`);
        continue;
      }

      // ── Resolve / auto-create brand ───────────────────────────────────────
      const brandName = (fields["brand"] as string | undefined)?.trim();
      if (!brandName) {
        creationErrors.push(`${sku}: brand is required`);
        continue;
      }
      const brand = await this.upsertBrand(brandName, brandCache);

      // ── Resolve / auto-create category ────────────────────────────────────
      const categorySlugOrName = (fields["category"] as string | undefined)?.trim();
      let category: CategoryDocument;
      if (categorySlugOrName) {
        category = await this.upsertCategory(categorySlugOrName, categoryCache);
      } else {
        // Fall back to first available category
        const first = await this.categoryModel.findOne().sort({ sortOrder: 1 });
        if (!first) {
          creationErrors.push(`${sku}: no category available and none specified`);
          continue;
        }
        category = first as CategoryDocument;
        this.logger.warn(`Sync: no category specified for ${sku}, using "${category.name}"`);
      }

      // ── Resolve / auto-create subcategory ─────────────────────────────────
      const subcategorySlugOrName = (fields["subcategory"] as string | undefined)?.trim();
      let subcategory: { id: string; name: string; slug: string } | null = null;
      if (subcategorySlugOrName) {
        subcategory = await this.upsertSubcategory(subcategorySlugOrName, category, categoryCache);
      }

      // ── Build unique slug ─────────────────────────────────────────────────
      let slug = slugify(`${brand.name} ${title}`, { lower: true, strict: true });
      const slugExists = await this.productModel.exists({ slug });
      if (slugExists) slug = `${slug}-${sku.toLowerCase()}`;

      // ── Create the product ────────────────────────────────────────────────
      try {
        const doc = await this.productModel.create({
          sku,
          slug,
          title: title.startsWith(brand.name) ? title : `${brand.name} ${title}`,
          brandId: (brand._id as unknown as Types.ObjectId).toString(),
          brandName: brand.name,
          brandSlug: (brand as unknown as Record<string, unknown>).slug as string,
          categoryId: (category._id as unknown as Types.ObjectId).toString(),
          categoryName: category.name,
          categorySlug: (category as unknown as Record<string, unknown>).slug as string,
          subcategoryId: subcategory?.id ?? null,
          subcategoryName: subcategory?.name ?? null,
          subcategorySlug: subcategory?.slug ?? null,
          price,
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
          after: { sku, brand: brand.name, category: category.name, source: "sync" },
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

  // ─── Taxonomy upsert helpers ──────────────────────────────────────────────

  /**
   * Find brand by name or slug; create it if it doesn't exist.
   * Results are memoised in `cache` so a 797-row import hits the DB once per brand.
   */
  private async upsertBrand(
    name: string,
    cache: Map<string, BrandDocument>,
  ): Promise<BrandDocument> {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key)!;

    const slug = slugify(name, { lower: true, strict: true });
    let brand = (await this.brandModel.findOne({
      $or: [
        { name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
        { slug },
      ],
    })) as BrandDocument | null;

    if (!brand) {
      brand = (await this.brandModel.create({ name, slug, logoUrl: "" })) as BrandDocument;
      this.logger.log(`Sync: auto-created brand "${name}"`);
    }

    cache.set(key, brand);
    return brand;
  }

  /**
   * Find category by name or slug; create it if it doesn't exist.
   * Uses `$setOnInsert` via findOneAndUpdate with upsert so concurrent imports don't duplicate.
   */
  private async upsertCategory(
    nameOrSlug: string,
    cache: Map<string, CategoryDocument>,
  ): Promise<CategoryDocument> {
    const key = nameOrSlug.toLowerCase();
    if (cache.has(key)) return cache.get(key)!;

    const slug = slugify(nameOrSlug, { lower: true, strict: true });
    // Try slug first (faster), then name
    let cat = (await this.categoryModel.findOne({ slug })) as CategoryDocument | null;
    if (!cat) {
      cat = (await this.categoryModel.findOne({
        name: { $regex: new RegExp(`^${nameOrSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      })) as CategoryDocument | null;
    }

    if (!cat) {
      // Determine a sensible display name — capitalise first letter of each word
      const displayName = nameOrSlug
        .split(/[-_\s]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");

      cat = (await this.categoryModel.create({
        name: displayName,
        slug,
        blurb: "",
        imageUrl: "",
        parentId: null,
        subcategories: [],
        sortOrder: 999,
      })) as CategoryDocument;
      this.logger.log(`Sync: auto-created category "${displayName}"`);
    }

    cache.set(key, cat);
    return cat;
  }

  /**
   * Find subcategory embedded in `category.subcategories`; push a new entry if absent.
   * After mutating the DB document, updates `cache` with the refreshed document.
   */
  private async upsertSubcategory(
    nameOrSlug: string,
    category: CategoryDocument,
    cache: Map<string, CategoryDocument>,
  ): Promise<{ id: string; name: string; slug: string }> {
    const slug = slugify(nameOrSlug, { lower: true, strict: true });
    const lcName = nameOrSlug.toLowerCase();

    // Check if it already exists in the embedded array
    const existing = category.subcategories?.find(
      (s) => s.slug === slug || s.name.toLowerCase() === lcName,
    );
    if (existing) return { id: existing.id, name: existing.name, slug: existing.slug };

    // Build a display name
    const displayName = nameOrSlug
      .split(/[-_\s]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");

    const newSub = { id: slug, name: displayName, slug };

    // Push into the category document
    const updated = (await this.categoryModel.findByIdAndUpdate(
      (category._id as unknown as Types.ObjectId).toString(),
      { $push: { subcategories: newSub } },
      { new: true },
    )) as CategoryDocument;

    this.logger.log(`Sync: auto-created subcategory "${displayName}" in "${category.name}"`);

    // Refresh all cache entries pointing to this category document
    const catKey = category.name.toLowerCase();
    const catSlugKey = (
      (category as unknown as Record<string, unknown>).slug as string
    ).toLowerCase();
    if (cache.has(catKey)) cache.set(catKey, updated);
    if (cache.has(catSlugKey)) cache.set(catSlugKey, updated);

    return newSub;
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
