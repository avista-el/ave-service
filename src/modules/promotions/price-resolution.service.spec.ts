/**
 * Unit tests for PriceResolutionService.
 *
 * The DB is mocked via jest.fn() — no real Mongoose connection needed.
 * We stub `discountModel.find().lean()` to return controlled campaign fixtures.
 *
 * Tests cover:
 *  1. No active campaigns → effectivePrice === basePrice
 *  2. Catalogue-level application applies to every product
 *  3. Category-level application picks up NEW products added after the campaign
 *     was created (read-time resolution, not write-time fan-out)
 *  4. Product-level application overrides category-level (most-specific wins)
 *  5. Product-level on different campaign is not affected by category unapply
 *  6. Unapply (application.active = false) restores basePrice
 *  7. Two overlapping catalogue campaigns — highest discount wins
 *  8. couponCode + auto-apply → ConflictException
 *  9. Invalid coupon → BadRequestException
 * 10. Batch method resolves all products in one query
 */

import { ConflictException, BadRequestException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { PriceResolutionService, ResolvableProduct } from "./price-resolution.service";
import { DiscountCode } from "./schemas/discount-code.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): Types.ObjectId {
  return new Types.ObjectId();
}

/** Minimal campaign fixture with one active application. */
function makeCampaign(
  overrides: Partial<{
    type: "percent" | "fixed";
    value: number;
    active: boolean;
    startsAt: Date;
    endsAt: Date;
    usageLimit: number | null;
    usedCount: number;
    minOrderAmount: number | null;
    applications: any[];
  }> = {},
) {
  const now = new Date();
  return {
    _id: makeId(),
    code: `CODE-${Math.random().toString(36).slice(2).toUpperCase()}`,
    type: "percent" as const,
    value: 20,
    active: true,
    minOrderAmount: null,
    usageLimit: null,
    usedCount: 0,
    startsAt: new Date(now.getTime() - 1000),
    endsAt: new Date(now.getTime() + 86_400_000),
    applications: [],
    ...overrides,
  };
}

/** A product with price 100_000 NGN in category "televisions". */
function makeProduct(
  overrides: Partial<ResolvableProduct & { categorySlug?: string }> = {},
): ResolvableProduct {
  return {
    _id: makeId(),
    price: 100_000,
    categorySlug: "televisions",
    subcategorySlug: undefined,
    ...overrides,
  };
}

// ─── Mock model factory ───────────────────────────────────────────────────────

/**
 * Returns a mock Mongoose Model whose `find().lean()` chain resolves to
 * the given `campaigns` array.
 * For `findOne().lean()` we match by `code` in the filter.
 */
function mockDiscountModel(campaigns: ReturnType<typeof makeCampaign>[]) {
  // find().lean() — returns the filtered list
  const leanFind = jest.fn().mockResolvedValue(campaigns);
  const find = jest.fn().mockReturnValue({ lean: leanFind });

  // findOne().lean() — used by validateCoupon; matches by code field
  const leanFindOne = jest.fn().mockImplementation(async () => {
    // Return the first campaign whose code matches the filter's `code` field
    // (the actual filter object is opaque here — we just return the first
    //  campaign that looks like a valid coupon for simplicity)
    return campaigns.find((c) => c.active) ?? null;
  });
  const findOne = jest.fn().mockReturnValue({ lean: leanFindOne });

  return { find, findOne };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("PriceResolutionService", () => {
  let service: PriceResolutionService;
  let model: ReturnType<typeof mockDiscountModel>;

  async function bootstrap(campaigns: ReturnType<typeof makeCampaign>[]) {
    model = mockDiscountModel(campaigns);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceResolutionService,
        { provide: getModelToken(DiscountCode.name), useValue: model },
      ],
    }).compile();

    service = module.get(PriceResolutionService);
  }

  // ── 1. No active campaigns ────────────────────────────────────────────────

  it("returns basePrice when no campaigns are active", async () => {
    await bootstrap([]);
    const product = makeProduct();
    const result = await service.resolveEffectivePrice(product);

    expect(result.effectivePrice).toBe(product.price);
    expect(result.discountAmount).toBe(0);
    expect(result.appliedCampaign).toBeNull();
  });

  // ── 2. Catalogue-level application ───────────────────────────────────────

  it("applies a catalogue-level discount to any product", async () => {
    const campaign = makeCampaign({
      type: "percent",
      value: 10,
      applications: [
        {
          _id: makeId(),
          scope: "catalogue",
          targetId: null,
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: true,
        },
      ],
    });
    await bootstrap([campaign]);

    const product = makeProduct({ price: 200_000 });
    const result = await service.resolveEffectivePrice(product);

    // 10% of 200_000 = 20_000
    expect(result.discountAmount).toBe(20_000);
    expect(result.effectivePrice).toBe(180_000);
    expect(result.appliedCampaign?.source).toBe("auto_apply");
    expect(result.appliedCampaign?.value).toBe(10);
  });

  // ── 3. Category-level: picks up NEW products (read-time resolution) ───────

  it("applies a category-level discount to a product added AFTER the campaign (read-time resolution)", async () => {
    // Campaign was applied to "televisions" before this product existed.
    const campaign = makeCampaign({
      type: "percent",
      value: 15,
      applications: [
        {
          _id: makeId(),
          scope: "category",
          targetId: "televisions", // matches product.categorySlug
          appliedBy: "admin1",
          appliedAt: new Date(Date.now() - 7 * 86_400_000), // applied 7 days ago
          active: true,
        },
      ],
    });
    await bootstrap([campaign]);

    // This product was "added later" — its _id is brand-new, but it belongs
    // to the same category. Price resolution happens at read-time.
    const newProduct = makeProduct({ _id: makeId(), categorySlug: "televisions" });
    const result = await service.resolveEffectivePrice(newProduct);

    expect(result.discountAmount).toBe(15_000); // 15% of 100_000
    expect(result.effectivePrice).toBe(85_000);
    expect(result.appliedCampaign?.source).toBe("auto_apply");
  });

  it("does NOT apply a category-level discount to a product in a different category", async () => {
    const campaign = makeCampaign({
      applications: [
        {
          _id: makeId(),
          scope: "category",
          targetId: "televisions",
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: true,
        },
      ],
    });
    await bootstrap([campaign]);

    const product = makeProduct({ categorySlug: "refrigerators" });
    const result = await service.resolveEffectivePrice(product);

    expect(result.discountAmount).toBe(0);
    expect(result.effectivePrice).toBe(product.price);
  });

  // ── 4. Precedence: product > category ────────────────────────────────────

  it("product-level application wins over category-level from a different campaign", async () => {
    const productId = makeId();

    const categoryCampaign = makeCampaign({
      value: 20, // 20% off
      applications: [
        {
          _id: makeId(),
          scope: "category",
          targetId: "televisions",
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: true,
        },
      ],
    });

    const productCampaign = makeCampaign({
      value: 5, // only 5% — but product-level wins regardless of amount
      applications: [
        {
          _id: makeId(),
          scope: "product",
          targetId: productId.toString(),
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: true,
        },
      ],
    });

    await bootstrap([categoryCampaign, productCampaign]);

    const product = makeProduct({ _id: productId, categorySlug: "televisions" });
    const result = await service.resolveEffectivePrice(product);

    // product-level (5%) should win — most-specific, not highest amount
    expect(result.appliedCampaign?.value).toBe(5);
    expect(result.discountAmount).toBe(5_000); // 5% of 100_000
  });

  // ── 5. Unapplying category does NOT touch product with its own binding ────

  it("unapplied category application does not affect a product with its own product-level binding", async () => {
    const productId = makeId();

    // Category campaign has been deactivated (active: false) — simulates unapply.
    const categoryCampaign = makeCampaign({
      value: 20,
      applications: [
        {
          _id: makeId(),
          scope: "category",
          targetId: "televisions",
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: false, // <-- unapplied
        },
      ],
    });

    // Independent product-level campaign is still active.
    const productCampaign = makeCampaign({
      value: 10,
      applications: [
        {
          _id: makeId(),
          scope: "product",
          targetId: productId.toString(),
          appliedBy: "admin2",
          appliedAt: new Date(),
          active: true,
        },
      ],
    });

    // fetchActiveCampaigns only returns campaigns with applications.active = true.
    // Simulate this by filtering in the mock (real Mongo query would do this).
    const activeCampaigns = [categoryCampaign, productCampaign].filter((c) =>
      c.applications.some((a) => a.active),
    );
    await bootstrap(activeCampaigns);

    const product = makeProduct({ _id: productId, categorySlug: "televisions" });
    const result = await service.resolveEffectivePrice(product);

    // Product-level binding is untouched — still applies its 10% discount.
    expect(result.discountAmount).toBe(10_000);
    expect(result.appliedCampaign?.value).toBe(10);
  });

  // ── 6. Unapply (active: false) restores basePrice ─────────────────────────

  it("restores basePrice when the only application is deactivated", async () => {
    const campaign = makeCampaign({
      value: 25,
      applications: [
        {
          _id: makeId(),
          scope: "catalogue",
          targetId: null,
          appliedBy: "admin1",
          appliedAt: new Date(),
          active: false, // deactivated
        },
      ],
    });

    // Filter out inactive applications (mirrors DB query behaviour).
    const activeCampaigns = [campaign].filter((c) => c.applications.some((a) => a.active));
    await bootstrap(activeCampaigns);

    const product = makeProduct();
    const result = await service.resolveEffectivePrice(product);

    expect(result.effectivePrice).toBe(product.price);
    expect(result.discountAmount).toBe(0);
    expect(result.appliedCampaign).toBeNull();
  });

  // ── 7. Two overlapping campaigns at same scope — highest discount wins ────

  it("picks the higher discount when two catalogue campaigns overlap", async () => {
    const low = makeCampaign({
      value: 10,
      applications: [{ _id: makeId(), scope: "catalogue", targetId: null, appliedBy: "a", appliedAt: new Date(), active: true }],
    });
    const high = makeCampaign({
      value: 30,
      applications: [{ _id: makeId(), scope: "catalogue", targetId: null, appliedBy: "a", appliedAt: new Date(), active: true }],
    });

    await bootstrap([low, high]);

    const product = makeProduct({ price: 100_000 });
    const result = await service.resolveEffectivePrice(product);

    expect(result.discountAmount).toBe(30_000); // 30% wins
    expect(result.appliedCampaign?.value).toBe(30);
  });

  // ── 8. Auto-apply + coupon code → ConflictException ──────────────────────

  it("throws ConflictException when a coupon is supplied but auto-apply is active", async () => {
    const campaign = makeCampaign({
      value: 20,
      applications: [
        { _id: makeId(), scope: "catalogue", targetId: null, appliedBy: "a", appliedAt: new Date(), active: true },
      ],
    });
    await bootstrap([campaign]);

    const product = makeProduct();
    await expect(service.resolveEffectivePrice(product, "MYCODE")).rejects.toThrow(
      ConflictException,
    );
  });

  // ── 9. Invalid coupon → BadRequestException ───────────────────────────────

  it("throws BadRequestException for an invalid/expired coupon when no auto-apply exists", async () => {
    // No auto-apply campaigns active.
    const expiredCampaign = makeCampaign({
      active: false,
      applications: [],
    });
    // Return nothing from find (no active auto-apply), and nothing from findOne (expired coupon).
    const m = {
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceResolutionService,
        { provide: getModelToken(DiscountCode.name), useValue: m },
      ],
    }).compile();
    service = module.get(PriceResolutionService);

    void expiredCampaign; // suppress unused warning
    const product = makeProduct();
    await expect(service.resolveEffectivePrice(product, "BADCODE")).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── 10. Batch resolution ──────────────────────────────────────────────────

  it("resolveEffectivePriceBatch resolves all products in one DB call", async () => {
    const campaign = makeCampaign({
      type: "percent",
      value: 10,
      applications: [
        { _id: makeId(), scope: "catalogue", targetId: null, appliedBy: "a", appliedAt: new Date(), active: true },
      ],
    });
    await bootstrap([campaign]);

    const products = [
      makeProduct({ price: 100_000 }),
      makeProduct({ price: 200_000 }),
      makeProduct({ price: 50_000 }),
    ];

    const map = await service.resolveEffectivePriceBatch(products);

    expect(map.size).toBe(3);
    for (const p of products) {
      const r = map.get(p._id.toString())!;
      expect(r.discountAmount).toBe(Math.round((p.price * 10) / 100));
      expect(r.effectivePrice).toBe(p.price - r.discountAmount);
    }

    // Exactly one DB call for the whole batch.
    expect(model.find).toHaveBeenCalledTimes(1);
  });

  // ── computeDiscount unit tests ────────────────────────────────────────────

  describe("computeDiscount", () => {
    beforeEach(async () => {
      await bootstrap([]);
    });

    it("computes percent discount correctly", () => {
      const result = service.computeDiscount(100_000, { type: "percent", value: 15 });
      expect(result).toBe(15_000);
    });

    it("rounds percent discount to nearest integer", () => {
      // 7% of 100_001 = 7000.07 → rounded to 7000
      const result = service.computeDiscount(100_001, { type: "percent", value: 7 });
      expect(result).toBe(7000);
    });

    it("computes fixed discount correctly", () => {
      const result = service.computeDiscount(100_000, { type: "fixed", value: 5_000 });
      expect(result).toBe(5_000);
    });

    it("caps fixed discount at product price (no negative effective price)", () => {
      const result = service.computeDiscount(3_000, { type: "fixed", value: 10_000 });
      expect(result).toBe(3_000);
    });
  });
});
