import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  SyncSource,
  SyncSourceDocument,
  SyncRun,
  SyncRunDocument,
  SyncRunFieldChange,
  SyncRunNewProduct,
} from "./schemas/sync.schema";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";
import { InventoryService } from "../inventory/inventory.service";
import { AuditLogService } from "../audit-log/audit-log.service";

const CLEAR_MARKER = "CLEAR";

// Plain lean types avoid FlattenMaps<Document> incompatibility
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

    const updatedFields: SyncRunFieldChange[] = [];
    const newProducts: SyncRunNewProduct[] = [];
    const errors: Array<{ row: number; sku?: string; message: string }> = [];
    let unchangedCount = 0;

    const allSkus = new Set(
      rows.map((r) => r[mapping["sku"]]?.trim().toUpperCase()).filter(Boolean) as string[],
    );

    const existingProducts = await this.productModel
      .find({ sku: { $in: Array.from(allSkus) } })
      .lean<LeanProduct[]>();

    const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));
    const sheetSkus = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 2;

      const sku = row[mapping["sku"]]?.trim().toUpperCase();
      if (!sku) {
        errors.push({ row: rowNum, message: "SKU is missing or blank" });
        continue;
      }
      sheetSkus.add(sku);

      const existing = productBySku.get(sku);

      if (!existing) {
        const title = row[mapping["title"] ?? ""] ?? "";
        const rawPrice = row[mapping["price"] ?? ""];
        const price = rawPrice ? parseFloat(rawPrice) : null;
        if (!title) {
          errors.push({ row: rowNum, sku, message: "New product missing required field: title" });
          continue;
        }
        if (price === null || isNaN(price)) {
          errors.push({ row: rowNum, sku, message: "New product missing required field: price" });
          continue;
        }
        newProducts.push({ sku, fields: this.rowToFields(row, mapping) });
        continue;
      }

      const fields = this.rowToFields(row, mapping);
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
    selectedChanges: string[],
    actorId: string,
  ): Promise<{ applied: number; skipped: number }> {
    const run = await this.runModel.findById(runId);
    if (!run) throw new NotFoundException("Sync run not found");
    if (!["pending_review", "partially_approved"].includes(run.status)) {
      throw new BadRequestException("Sync run is not in a reviewable state");
    }

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

      // compareAtPrice needs explicit handling — it maps to a product field
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

    const skipped = toApply.length - applied;
    run.status = applied > 0 ? "published" : "partially_approved";
    run.reviewedBy = actorId;
    run.reviewedAt = new Date();
    await run.save();

    return { applied, skipped };
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

    // Full field map: system field name → Product schema field name
    // Includes all columns present in the CSV template
    const fieldMap: Record<string, string> = {
      title: "title",
      price: "price",
      price_ngn: "price", // CSV template alias
      compare_at: "compareAtPrice",
      compare_at_ngn: "compareAtPrice", // CSV template alias
      stock: "stock",
      stock_qty: "stock", // CSV template alias
      description: "description",
      images: "images",
      image_urls: "images", // CSV template alias
      status: "status",
      tags: "tags",
      // brand/category/subcategory are informational only in updates —
      // they are accepted but treated as metadata, not written directly
      // (product brand/category refs are set on creation, not via sync)
    };

    for (const [systemField, colName] of Object.entries(mapping)) {
      const schemaField = fieldMap[systemField];
      if (!schemaField) continue;

      // Look up by the column name as written in the sheet header or letter
      const raw = row[colName] ?? row[systemField];
      if (raw === undefined || raw === null || raw === "") continue;

      switch (schemaField) {
        case "price":
        case "compareAtPrice": {
          // Strip currency symbols / commas before parsing
          const cleaned = raw.replace(/[₦,\s]/g, "");
          const num = parseFloat(cleaned);
          if (!isNaN(num)) result[schemaField] = num;
          break;
        }
        case "stock": {
          const num = parseInt(raw, 10);
          // Keep as string so the executeRun stock path can validate
          result["stock"] = isNaN(num) ? raw : String(num);
          break;
        }
        case "images":
        case "image_urls": {
          // Comma- or newline-separated URLs
          const urls = raw
            .split(/[,\n]/)
            .map((u) => u.trim())
            .filter(Boolean);
          if (urls.length) result["images"] = urls;
          break;
        }
        case "tags": {
          // Comma-separated tag values e.g. "deal,best_seller"
          const validTags = ["new_arrival", "best_seller", "featured", "deal"];
          const tags = raw
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter((t) => validTags.includes(t));
          if (tags.length) result["tags"] = tags;
          break;
        }
        default:
          result[schemaField] = raw;
      }
    }
    return result;
  }
}
