/**
 * PriceResolutionService
 *
 * Single source of truth for computing a product's effective price.
 * Used by BOTH storefront display (CatalogService) and checkout (OrderService).
 *
 * Precedence (most-specific wins, first match, NO stacking):
 *   1. Direct product-level application   (scope = 'product',   targetId = productId)
 *   2. Category-level application         (scope = 'category',  targetId = categorySlug)
 *   3. Catalogue-wide application         (scope = 'catalogue', targetId = null)
 *
 * Auto-apply and coupon codes are mutually exclusive per the spec:
 *   - If an auto-apply discount is active, a coupon code throws ConflictException.
 *   - If no auto-apply matches, a coupon code is validated and applied.
 *   - If neither applies, price === basePrice.
 *
 * When the same product matches more than one campaign at the same scope level
 * (e.g. two catalogue-wide campaigns are both active), the one with the higher
 * computed discount amount wins. This is deterministic and avoids silent stacking.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { DiscountCode, DiscountCodeDocument } from "./schemas/discount-code.schema";

// ─── Input shape ─────────────────────────────────────────────────────────────

/**
 * Minimal product fields the resolver needs.
 * Intentionally narrow so callers don't have to pass a full Mongoose document.
 */
export interface ResolvableProduct {
  /** Mongoose _id as string or ObjectId — used for product-scope matching. */
  _id: Types.ObjectId | string;
  /** The product's stored base price (NGN). */
  price: number;
  /** Category slug — used for category-scope matching. */
  categorySlug: string;
  /** Subcategory slug — also checked for category-scope matching. */
  subcategorySlug?: string | null;
}

// ─── Output shape ────────────────────────────────────────────────────────────

export interface ResolvedPrice {
  /** The price the customer should pay (after best discount). */
  effectivePrice: number;
  /** Amount saved (0 when no discount applies). */
  discountAmount: number;
  /**
   * The campaign that produced the discount, or null.
   * Callers can use this to surface "X% off — applied automatically" UI.
   */
  appliedCampaign: AppliedCampaignInfo | null;
}

export interface AppliedCampaignInfo {
  campaignId: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
  source: "auto_apply" | "coupon_code";
}

// ─── Internal lean type ───────────────────────────────────────────────────────

type LeanCampaign = {
  _id: Types.ObjectId;
  code: string;
  type: "percent" | "fixed";
  value: number;
  minOrderAmount: number | null;
  startsAt: Date;
  endsAt: Date;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  applications: Array<{
    _id: Types.ObjectId;
    scope: "product" | "category" | "catalogue";
    targetId: string | null;
    appliedBy: string;
    appliedAt: Date;
    active: boolean;
  }>;
};

@Injectable()
export class PriceResolutionService {
  constructor(
    @InjectModel(DiscountCode.name)
    private readonly discountModel: Model<DiscountCodeDocument>,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Resolve the effective price for a single product.
   *
   * @param product   Minimal product fields (price, categorySlug, etc.)
   * @param couponCode  Optional customer-entered code. Conflicts with auto-apply.
   */
  async resolveEffectivePrice(
    product: ResolvableProduct,
    couponCode?: string,
  ): Promise<ResolvedPrice> {
    const now = new Date();
    const productId = product._id.toString();

    // 1. Find the best auto-applied campaign for this product.
    const autoMatch = await this.findBestAutoApply(product, now);

    if (autoMatch) {
      // Auto-apply is active — coupons cannot be stacked.
      if (couponCode) {
        throw new ConflictException(
          "A discount is already applied to this product. Coupon codes cannot be combined with auto-applied promotions.",
        );
      }
      const discountAmount = this.computeDiscount(product.price, autoMatch);
      return {
        effectivePrice: Math.max(0, product.price - discountAmount),
        discountAmount,
        appliedCampaign: {
          campaignId: autoMatch._id.toString(),
          code: autoMatch.code,
          type: autoMatch.type,
          value: autoMatch.value,
          source: "auto_apply",
        },
      };
    }

    // 2. No auto-apply — try customer coupon code.
    if (couponCode) {
      const campaign = await this.validateCoupon(couponCode, product.price, now);
      const discountAmount = this.computeDiscount(product.price, campaign);
      return {
        effectivePrice: Math.max(0, product.price - discountAmount),
        discountAmount,
        appliedCampaign: {
          campaignId: campaign._id.toString(),
          code: campaign.code,
          type: campaign.type,
          value: campaign.value,
          source: "coupon_code",
        },
      };
    }

    // 3. No discount of any kind.
    return { effectivePrice: product.price, discountAmount: 0, appliedCampaign: null };
  }

  /**
   * Resolve prices for a batch of products in a SINGLE query.
   * Used by list endpoints so N products don't fire N queries.
   *
   * Coupon codes are not supported in batch mode (they apply at cart level,
   * not product-list level). Pass them only to the single-product variant.
   */
  async resolveEffectivePriceBatch(
    products: ResolvableProduct[],
  ): Promise<Map<string, ResolvedPrice>> {
    const now = new Date();
    const productIds = products.map((p) => p._id.toString());
    const categorySlugs = [
      ...new Set(products.flatMap((p) => [p.categorySlug, p.subcategorySlug].filter(Boolean))),
    ] as string[];

    // Fetch all campaigns that could possibly match any of these products.
    const campaigns = await this.fetchActiveCampaigns(now);

    const result = new Map<string, ResolvedPrice>();
    for (const product of products) {
      const best = this.selectBestAutoApply(product, campaigns);
      if (best) {
        const discountAmount = this.computeDiscount(product.price, best);
        result.set(product._id.toString(), {
          effectivePrice: Math.max(0, product.price - discountAmount),
          discountAmount,
          appliedCampaign: {
            campaignId: best._id.toString(),
            code: best.code,
            type: best.type,
            value: best.value,
            source: "auto_apply",
          },
        });
      } else {
        result.set(product._id.toString(), {
          effectivePrice: product.price,
          discountAmount: 0,
          appliedCampaign: null,
        });
      }
    }

    void productIds; // used implicitly via product._id iteration above
    void categorySlugs;
    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Query DB for a single product's best auto-apply match.
   * Used by the single-product path so we don't over-fetch in list contexts.
   */
  private async findBestAutoApply(
    product: ResolvableProduct,
    now: Date,
  ): Promise<LeanCampaign | null> {
    const campaigns = await this.fetchActiveCampaigns(now);
    return this.selectBestAutoApply(product, campaigns);
  }

  /**
   * Pull all currently active campaigns that have at least one active application.
   * Called once per request — callers cache the result for batch processing.
   */
  private async fetchActiveCampaigns(now: Date): Promise<LeanCampaign[]> {
    return this.discountModel
      .find({
        active: true,
        startsAt: { $lte: now },
        endsAt: { $gte: now },
        "applications.active": true,
      })
      .lean<LeanCampaign[]>();
  }

  /**
   * Pure (no DB) function: given a pre-fetched campaign list, find the
   * best matching campaign for a product using the precedence rules.
   *
   * Precedence: product → category → catalogue.
   * Within the same scope level, highest discount amount wins (deterministic
   * tie-breaking; avoids silent stacking).
   */
  private selectBestAutoApply(
    product: ResolvableProduct,
    campaigns: LeanCampaign[],
  ): LeanCampaign | null {
    const productId = product._id.toString();

    // Bucket campaigns by their best matching scope for this product.
    const buckets: Array<{ priority: number; campaign: LeanCampaign }> = [];

    for (const campaign of campaigns) {
      const activeApps = campaign.applications.filter((a) => a.active);

      const productMatch = activeApps.some(
        (a) => a.scope === "product" && a.targetId === productId,
      );
      if (productMatch) {
        buckets.push({ priority: 0, campaign });
        continue;
      }

      const categoryMatch = activeApps.some(
        (a) =>
          a.scope === "category" &&
          (a.targetId === product.categorySlug ||
            (product.subcategorySlug && a.targetId === product.subcategorySlug)),
      );
      if (categoryMatch) {
        buckets.push({ priority: 1, campaign });
        continue;
      }

      const catalogueMatch = activeApps.some((a) => a.scope === "catalogue");
      if (catalogueMatch) {
        buckets.push({ priority: 2, campaign });
      }
    }

    if (buckets.length === 0) return null;

    // Sort: lowest priority number first (most specific), then highest discount
    // amount descending as tie-breaker within the same scope level.
    buckets.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Same scope level — pick higher discount
      const discA = this.computeDiscount(product.price, a.campaign);
      const discB = this.computeDiscount(product.price, b.campaign);
      return discB - discA;
    });

    return buckets[0].campaign;
  }

  /**
   * Validate a customer coupon code.
   * Does NOT increment usedCount — that happens after successful payment.
   */
  private async validateCoupon(
    code: string,
    orderTotal: number,
    now: Date,
  ): Promise<LeanCampaign> {
    const doc = await this.discountModel
      .findOne({
        code: code.toUpperCase().trim(),
        active: true,
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      })
      .lean<LeanCampaign>();

    if (!doc) throw new BadRequestException("Invalid or expired promo code");

    if (doc.usageLimit !== null && doc.usedCount >= doc.usageLimit) {
      throw new BadRequestException("Promo code usage limit reached");
    }

    if (doc.minOrderAmount !== null && orderTotal < doc.minOrderAmount) {
      throw new BadRequestException(
        `Minimum order amount for this code is ₦${doc.minOrderAmount.toLocaleString()}`,
      );
    }

    return doc;
  }

  /**
   * Compute discount amount in NGN for a given base price + campaign.
   * Shared by auto-apply and coupon paths — single formula.
   */
  computeDiscount(basePrice: number, campaign: Pick<LeanCampaign, "type" | "value">): number {
    if (campaign.type === "percent") {
      return Math.round((basePrice * campaign.value) / 100);
    }
    return Math.min(campaign.value, basePrice);
  }
}
