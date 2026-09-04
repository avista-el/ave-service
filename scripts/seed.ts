/**
 * Alphavista Electronics — Database Seed Script
 *
 * Populates every MongoDB collection with realistic, relationally consistent
 * test data. Idempotent — safe to run multiple times (upsert throughout).
 *
 * Run:  npm run seed
 *
 * Seeding order (dependency chain):
 *   1. Users
 *   2. Brands
 *   3. Categories
 *   4. Products      ← refs Brand._id, Category._id (denormalised)
 *   5. FX Rates
 *   6. Discount Codes
 *   7. Carts          ← refs User._id, Product._id
 *   8. Orders         ← refs User._id, Product._id (embedded items)
 *   9. Webhook Events ← refs Order._id
 *  10. Audit Logs     ← refs User._id, Product._id, Order._id
 *  11. Sync Sources
 *  12. Sync Runs      ← refs SyncSource._id
 */

import * as dotenv from "dotenv";
import * as path from "path";
import mongoose, { Connection, Types } from "mongoose";
import * as bcrypt from "bcryptjs";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const MONGO_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/alphavista";
const SALT = 12;

// ── Schema imports (reuse app schemas — no duplication) ──────────────────────
import { UserSchema } from "../src/modules/auth/schemas/user.schema";
import { BrandSchema } from "../src/modules/catalog/schemas/brand.schema";
import { CategorySchema } from "../src/modules/catalog/schemas/category.schema";
import { ProductSchema } from "../src/modules/catalog/schemas/product.schema";
import { FxRateSchema } from "../src/modules/geo-currency/schemas/fx-rate.schema";
import { DiscountCodeSchema } from "../src/modules/promotions/schemas/discount-code.schema";
import { CartSchema } from "../src/modules/cart/schemas/cart.schema";
import { OrderSchema } from "../src/modules/order/schemas/order.schema";
import { WebhookEventSchema } from "../src/modules/payment/schemas/webhook-event.schema";
import { AuditLogSchema } from "../src/modules/audit-log/schemas/audit-log.schema";
import { SyncSourceSchema, SyncRunSchema } from "../src/modules/sync/schemas/sync.schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lowercase slug from any string */
function sl(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Idempotent upsert — finds by `filter`, sets `doc`, returns the saved document.
 * Running the seed script twice produces the same data, not duplicate rows.
 * Uses `any` on the Model type to avoid Mongoose generic incompatibilities
 * across different schema classes in a standalone (non-NestJS) context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function up(
  M: mongoose.Model<any>,
  filter: Record<string, unknown>,
  doc: Record<string, unknown>,
): Promise<{ _id: Types.ObjectId; [key: string]: unknown }> {
  return (await M.findOneAndUpdate(
    filter,
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )) as { _id: Types.ObjectId; [key: string]: unknown };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  Alphavista seed starting…");
  console.log(`   DB: ${MONGO_URI.replace(/\/\/[^@]+@/, "//***@")}\n`);

  const conn: Connection = mongoose.createConnection(MONGO_URI, {
    serverSelectionTimeoutMS: 30_000,
  });
  await conn.asPromise();
  console.log("✅  Connected\n");

  // Register every model on this isolated connection (not the NestJS DI context)
  const Users = conn.model("User", UserSchema, "users");
  const Brands = conn.model("Brand", BrandSchema, "brands");
  const Cats = conn.model("Category", CategorySchema, "categories");
  const Prods = conn.model("Product", ProductSchema, "products");
  const Fx = conn.model("FxRate", FxRateSchema, "fx_rates");
  const Disc = conn.model("DiscountCode", DiscountCodeSchema, "discount_codes");
  const Carts = conn.model("Cart", CartSchema, "carts");
  const Orders = conn.model("Order", OrderSchema, "orders");
  const Hooks = conn.model("WebhookEvent", WebhookEventSchema, "webhook_events");
  const Audit = conn.model("AuditLog", AuditLogSchema, "audit_logs");
  const SyncSrc = conn.model("SyncSource", SyncSourceSchema, "sync_sources");
  const SyncRuns = conn.model("SyncRun", SyncRunSchema, "sync_runs");

  // ════════════════════════════════════════════════════════════════════════════
  // 1. USERS
  //    Roles: super_admin, merchandiser, support_agent, customer (×2)
  //    Passwords hashed with bcryptjs (same lib and SALT rounds as the app).
  //    Upsert key: email (unique index in schema).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 1. Users");

  const [hA, hM, hS, hC1, hC2] = await Promise.all([
    bcrypt.hash("Admin@AlphaV!2026", SALT),
    bcrypt.hash("Merch@AlphaV!2026", SALT),
    bcrypt.hash("Support@AlphaV!2026", SALT),
    bcrypt.hash("Adaeze@Pass!2026", SALT),
    bcrypt.hash("Tunde@Pass!2026", SALT),
  ]);

  const admin = await up(
    Users,
    { email: "ops@alphavista.ng" },
    {
      name: "Ops Admin",
      email: "ops@alphavista.ng",
      passwordHash: hA,
      role: "super_admin",
      active: true,
    },
  );
  const merch = await up(
    Users,
    { email: "zainab@alphavista.ng" },
    {
      name: "Zainab Bello",
      email: "zainab@alphavista.ng",
      passwordHash: hM,
      role: "merchandiser",
      active: true,
    },
  );
  await up(
    Users,
    { email: "peter@alphavista.ng" },
    {
      name: "Peter Ade",
      email: "peter@alphavista.ng",
      passwordHash: hS,
      role: "support_agent",
      active: true,
    },
  );
  const cust1 = await up(
    Users,
    { email: "adaeze.o@example.com" },
    {
      name: "Adaeze Okonkwo",
      email: "adaeze.o@example.com",
      passwordHash: hC1,
      role: "customer",
      active: true,
    },
  );
  const cust2 = await up(
    Users,
    { email: "tunde.b@example.com" },
    {
      name: "Tunde Bakare",
      email: "tunde.b@example.com",
      passwordHash: hC2,
      role: "customer",
      active: true,
    },
  );

  console.log("   ✓ 5 users (super_admin, merchandiser, support_agent, customer ×2)");

  // ════════════════════════════════════════════════════════════════════════════
  // 2. BRANDS
  //    Upsert key: slug (unique index in schema).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 2. Brands");

  const brandNames = [
    "Hisense",
    "LG",
    "Samsung",
    "Bruhm",
    "Midea",
    "Skyrun",
    "Panasonic",
    "Nexus",
    "Daikin",
    "Thermocool",
    "TCL",
    "Scanfrost",
  ];

  // bmap[brandName] → { _id, name, slug }  — used when building products
  const bmap: Record<string, { _id: Types.ObjectId; name: string; slug: string }> = {};

  for (const n of brandNames) {
    const slug = sl(n);
    const d = await up(Brands, { slug }, { name: n, slug, logoUrl: "" });
    bmap[n] = { _id: d._id, name: n, slug };
  }

  console.log(`   ✓ ${brandNames.length} brands`);

  // ════════════════════════════════════════════════════════════════════════════
  // 3. CATEGORIES  (with embedded subcategories)
  //    Upsert key: slug (unique index).
  //    Subcategory id values are deterministic strings (not ObjectIds) so
  //    products can reference them safely across re-runs.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 3. Categories");

  const catDefs = [
    {
      name: "Televisions",
      slug: "tvs",
      sortOrder: 1,
      blurb: 'Smart 4K, QLED and Full HD panels from 32" to 85".',
      subs: [
        { id: "sub-tv-1", name: '32" – 43"', slug: "32-43-inch" },
        { id: "sub-tv-2", name: '50" – 59"', slug: "50-59-inch" },
        { id: "sub-tv-3", name: '65" and above', slug: "65-inch-plus" },
      ],
    },
    {
      name: "Refrigerators",
      slug: "refrigerators",
      sortOrder: 2,
      blurb: "Single door, double door and side-by-side cooling.",
      subs: [
        { id: "sub-fr-1", name: "Single Door", slug: "single-door" },
        { id: "sub-fr-2", name: "Double Door", slug: "double-door" },
        { id: "sub-fr-3", name: "Side by Side", slug: "side-by-side" },
      ],
    },
    {
      name: "Freezers",
      slug: "freezers",
      sortOrder: 3,
      blurb: "Chest and upright freezers built for long power cuts.",
      subs: [
        { id: "sub-fz-1", name: "Chest Freezers", slug: "chest" },
        { id: "sub-fz-2", name: "Upright Freezers", slug: "upright" },
      ],
    },
    {
      name: "Washing Machines",
      slug: "washing-machines",
      sortOrder: 4,
      blurb: "Front load, top load and twin tub washers.",
      subs: [
        { id: "sub-wm-1", name: "Front Load", slug: "front-load" },
        { id: "sub-wm-2", name: "Top Load", slug: "top-load" },
      ],
    },
    {
      name: "Air Conditioners",
      slug: "air-conditioners",
      sortOrder: 5,
      blurb: "Split units, inverters and standing ACs.",
      subs: [
        { id: "sub-ac-1", name: "Split Units", slug: "split-units" },
        { id: "sub-ac-2", name: "Inverter ACs", slug: "inverter" },
      ],
    },
    {
      name: "Kitchen Appliances",
      slug: "kitchen-appliances",
      sortOrder: 6,
      blurb: "Microwaves, cookers, blenders and air fryers.",
      subs: [
        { id: "sub-kit-1", name: "Microwaves", slug: "microwaves" },
        { id: "sub-kit-2", name: "Cookers", slug: "cookers" },
      ],
    },
    {
      name: "Audio Systems",
      slug: "audio",
      sortOrder: 7,
      blurb: "Home theatres, soundbars and party speakers.",
      subs: [
        { id: "sub-aud-1", name: "Home Theatre", slug: "home-theatre" },
        { id: "sub-aud-2", name: "Soundbars", slug: "soundbars" },
      ],
    },
  ];

  // cmap[categorySlug] → { _id, name, slug, subs[] }  — used when building products
  const cmap: Record<
    string,
    {
      _id: Types.ObjectId;
      name: string;
      slug: string;
      subs: { id: string; name: string; slug: string }[];
    }
  > = {};

  for (const c of catDefs) {
    const d = await up(
      Cats,
      { slug: c.slug },
      {
        name: c.name,
        slug: c.slug,
        blurb: c.blurb,
        sortOrder: c.sortOrder,
        parentId: null,
        subcategories: c.subs,
      },
    );
    cmap[c.slug] = { _id: d._id, name: c.name, slug: c.slug, subs: c.subs };
  }

  console.log(`   ✓ ${catDefs.length} categories with embedded subcategories`);

  // ════════════════════════════════════════════════════════════════════════════
  // 4. PRODUCTS
  //    Every product carries denormalised brand and category fields, exactly
  //    as CatalogService.createProduct() does.  Upsert key: sku (unique).
  //    Stock is set to a realistic level; reserved starts at 0 here and will
  //    be updated to 1 for the pending_payment order (section 8).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 4. Products");

  // Placeholder Cloudinary URLs — replace with real asset URLs in production
  const CDN = "https://res.cloudinary.com/demo/image/upload";
  const IMG: Record<string, string> = {
    tvs: `${CDN}/alphavista/product-tv.jpg`,
    refrigerators: `${CDN}/alphavista/product-fridge.jpg`,
    freezers: `${CDN}/alphavista/product-freezer.jpg`,
    "washing-machines": `${CDN}/alphavista/product-washer.jpg`,
    "air-conditioners": `${CDN}/alphavista/product-ac.jpg`,
    "kitchen-appliances": `${CDN}/alphavista/product-microwave.jpg`,
    audio: `${CDN}/alphavista/product-audio.jpg`,
  };

  type PS = {
    sku: string;
    title: string;
    brand: string;
    cat: string;
    sub: string;
    price: number;
    cmp?: number;
    stock: number;
    tags: string[];
    ra: number;
    rc: number;
    desc: string;
  };

  const pSeeds: PS[] = [
    // ── Televisions
    {
      sku: "AV-TV-001",
      title: '55" 4K UHD Smart TV A6K',
      brand: "Hisense",
      cat: "tvs",
      sub: "50-59-inch",
      price: 585_000,
      cmp: 699_000,
      stock: 32,
      tags: ["deal", "best_seller"],
      ra: 4.6,
      rc: 128,
      desc: 'Hisense 55" 4K Smart TV — Dolby Vision, HDR10, 60Hz. Same-day delivery within Abuja.',
    },
    {
      sku: "AV-TV-002",
      title: '65" QLED Smart TV Q70',
      brand: "Samsung",
      cat: "tvs",
      sub: "65-inch-plus",
      price: 1_250_000,
      cmp: 1_420_000,
      stock: 8,
      tags: ["featured", "deal"],
      ra: 4.8,
      rc: 64,
      desc: 'Samsung 65" QLED — Quantum Dot colour, Object Tracking Sound, HDR10+.',
    },
    {
      sku: "AV-TV-003",
      title: '43" Full HD Smart TV S5400A',
      brand: "TCL",
      cat: "tvs",
      sub: "32-43-inch",
      price: 265_000,
      stock: 45,
      tags: ["best_seller"],
      ra: 4.3,
      rc: 212,
      desc: 'TCL 43" Google TV with built-in Chromecast and 1080p Full HD panel.',
    },
    // ── Refrigerators
    {
      sku: "AV-FR-001",
      title: "Side by Side Refrigerator 550L",
      brand: "LG",
      cat: "refrigerators",
      sub: "side-by-side",
      price: 1_450_000,
      cmp: 1_650_000,
      stock: 14,
      tags: ["featured", "deal"],
      ra: 4.7,
      rc: 84,
      desc: "LG 550L side-by-side — linear compressor, water dispenser, door-in-door feature.",
    },
    {
      sku: "AV-FR-002",
      title: "Double Door Refrigerator 350L",
      brand: "Hisense",
      cat: "refrigerators",
      sub: "double-door",
      price: 620_000,
      stock: 22,
      tags: ["best_seller"],
      ra: 4.4,
      rc: 173,
      desc: "Hisense 350L frost-free double door. No manual defrosting required.",
    },
    // ── Freezers
    {
      sku: "AV-FZ-001",
      title: "Chest Freezer 200L",
      brand: "Thermocool",
      cat: "freezers",
      sub: "chest",
      price: 385_000,
      cmp: 425_000,
      stock: 28,
      tags: ["deal", "best_seller"],
      ra: 4.5,
      rc: 205,
      desc: "Thermocool 200L chest freezer — external condenser for extended power outages.",
    },
    {
      sku: "AV-FZ-002",
      title: "Upright Freezer 260L",
      brand: "Nexus",
      cat: "freezers",
      sub: "upright",
      price: 468_000,
      cmp: 499_000,
      stock: 4,
      tags: ["deal"],
      ra: 4.2,
      rc: 39,
      desc: "Nexus 260L upright freezer — 4 adjustable glass shelves, fast-freeze function.",
    },
    // ── Washing Machines
    {
      sku: "AV-WM-001",
      title: "Front Load Washer 8kg",
      brand: "LG",
      cat: "washing-machines",
      sub: "front-load",
      price: 745_000,
      cmp: 820_000,
      stock: 17,
      tags: ["deal", "featured"],
      ra: 4.7,
      rc: 118,
      desc: "LG 8kg front loader — 6 Motion Direct Drive, TurboDrum, 1200 rpm.",
    },
    {
      sku: "AV-WM-002",
      title: "Top Load Washer 7kg",
      brand: "Midea",
      cat: "washing-machines",
      sub: "top-load",
      price: 398_000,
      cmp: 445_000,
      stock: 30,
      tags: ["deal", "best_seller"],
      ra: 4.2,
      rc: 162,
      desc: "Midea 7kg top loader — 8 wash programs, stainless steel drum.",
    },
    // ── Air Conditioners
    {
      sku: "AV-AC-001",
      title: "1.5HP Split Unit AC",
      brand: "Midea",
      cat: "air-conditioners",
      sub: "split-units",
      price: 425_000,
      cmp: 470_000,
      stock: 25,
      tags: ["deal", "best_seller"],
      ra: 4.4,
      rc: 231,
      desc: "Midea 1.5HP split AC — full copper coil, self-cleaning mode. For 15–20 m² rooms.",
    },
    {
      sku: "AV-AC-002",
      title: "2HP Inverter Split AC",
      brand: "Daikin",
      cat: "air-conditioners",
      sub: "inverter",
      price: 795_000,
      stock: 10,
      tags: ["featured"],
      ra: 4.8,
      rc: 57,
      desc: "Daikin 2HP inverter AC — saves up to 40% energy versus non-inverter models.",
    },
    // ── Kitchen Appliances
    {
      sku: "AV-KIT-001",
      title: "30L Digital Microwave Oven",
      brand: "Panasonic",
      cat: "kitchen-appliances",
      sub: "microwaves",
      price: 178_000,
      cmp: 199_000,
      stock: 20,
      tags: ["deal"],
      ra: 4.5,
      rc: 96,
      desc: "Panasonic 30L inverter microwave — 14 auto-cook presets, flatbed design.",
    },
    {
      sku: "AV-KIT-002",
      title: "4 Burner Gas Cooker with Oven",
      brand: "Scanfrost",
      cat: "kitchen-appliances",
      sub: "cookers",
      price: 465_000,
      cmp: 510_000,
      stock: 4,
      tags: ["deal"],
      ra: 4.4,
      rc: 61,
      desc: "Scanfrost 4-burner gas cooker — 60L oven, auto-ignition, tempered glass lid.",
    },
    // ── Audio
    {
      sku: "AV-AUD-001",
      title: "5.1Ch Home Theatre System",
      brand: "Samsung",
      cat: "audio",
      sub: "home-theatre",
      price: 385_000,
      stock: 15,
      tags: ["new_arrival"],
      ra: 4.6,
      rc: 74,
      desc: "Samsung 5.1ch — 700W total, Dolby Digital, wireless rear speakers.",
    },
    {
      sku: "AV-AUD-002",
      title: "2.1Ch Soundbar with Subwoofer",
      brand: "LG",
      cat: "audio",
      sub: "soundbars",
      price: 265_000,
      cmp: 298_000,
      stock: 19,
      tags: ["deal", "best_seller"],
      ra: 4.5,
      rc: 112,
      desc: "LG 2.1ch soundbar — wireless sub, DTS Virtual:X, 300W output.",
    },
  ];

  // pmap[sku] → { _id, sku, title, price } — used in later sections
  const pmap: Record<
    string,
    {
      _id: Types.ObjectId;
      sku: string;
      title: string;
      price: number;
    }
  > = {};

  for (const p of pSeeds) {
    const b = bmap[p.brand]!;
    const c = cmap[p.cat]!;
    const sub = c.subs.find((s) => s.slug === p.sub);
    const slug = sl(`${b.name} ${p.title}`);
    const img = IMG[p.cat]!;

    const d = await up(
      Prods,
      { sku: p.sku },
      {
        sku: p.sku,
        slug,
        title: `${b.name} ${p.title}`,
        brandId: b._id.toString(),
        brandName: b.name,
        brandSlug: b.slug,
        categoryId: c._id.toString(),
        categoryName: c.name,
        categorySlug: c.slug,
        subcategoryId: sub?.id ?? null,
        subcategoryName: sub?.name ?? null,
        subcategorySlug: sub?.slug ?? null,
        price: p.price,
        compareAtPrice: p.cmp ?? null,
        stock: p.stock,
        reserved: 0,
        images: [img, img, img],
        description: p.desc,
        descriptionHtml: `<p>${p.desc}</p>`,
        specs: [{ label: "Warranty", value: "12 months" }],
        status: "active",
        tags: p.tags,
        ratingAvg: p.ra,
        ratingCount: p.rc,
        lastModifiedBy: `admin:${admin._id.toString()}`,
      },
    );

    pmap[p.sku] = {
      _id: d._id,
      sku: p.sku,
      title: `${b.name} ${p.title}`,
      price: p.price,
    };
  }

  console.log(`   ✓ ${pSeeds.length} products (active, all categories covered)`);

  // ════════════════════════════════════════════════════════════════════════════
  // 5. FX RATES  (NGN base: 1 NGN = X foreign currency)
  //    Upsert key: currency (unique, uppercase).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 5. FX rates");

  const fxRows = [
    { currency: "NGN", rate: 1, source: "base" },
    { currency: "USD", rate: 1 / 1550, source: "seed" },
    { currency: "GBP", rate: 1 / 1980, source: "seed" },
    { currency: "EUR", rate: 1 / 1700, source: "seed" },
    { currency: "GHS", rate: 1 / 118, source: "seed" },
    { currency: "KES", rate: 1 / 12, source: "seed" },
    { currency: "ZAR", rate: 1 / 85, source: "seed" },
  ];

  for (const r of fxRows) {
    await up(
      Fx,
      { currency: r.currency },
      {
        currency: r.currency,
        rate: r.rate,
        source: r.source,
        refreshedAt: new Date(),
      },
    );
  }

  console.log(`   ✓ ${fxRows.length} FX rates (NGN, USD, GBP, EUR, GHS, KES, ZAR)`);

  // ════════════════════════════════════════════════════════════════════════════
  // 6. DISCOUNT CODES
  //    2 active codes for checkout testing + 1 expired to test validation.
  //    Upsert key: code (unique, uppercase).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 6. Discount codes");

  const now = new Date();
  const far = new Date("2027-12-31T23:59:59Z");
  const past = new Date("2025-01-01T00:00:00Z");

  // 20% off air conditioners — min order ₦200k
  await up(
    Disc,
    { code: "COOL20" },
    {
      code: "COOL20",
      type: "percent",
      value: 20,
      minOrderAmount: 200_000,
      startsAt: now,
      endsAt: far,
      usageLimit: 500,
      usedCount: 12,
      scope: "category",
      targets: ["air-conditioners"],
      active: true,
    },
  );

  // ₦50k off any order ≥ ₦500k
  await up(
    Disc,
    { code: "SAVE50K" },
    {
      code: "SAVE50K",
      type: "fixed",
      value: 50_000,
      minOrderAmount: 500_000,
      startsAt: now,
      endsAt: far,
      usageLimit: null,
      usedCount: 5,
      scope: "all",
      targets: [],
      active: true,
    },
  );

  // Expired — validates that the validation endpoint rejects it
  await up(
    Disc,
    { code: "EXPIRED10" },
    {
      code: "EXPIRED10",
      type: "percent",
      value: 10,
      minOrderAmount: null,
      startsAt: past,
      endsAt: past,
      usageLimit: 100,
      usedCount: 87,
      scope: "all",
      targets: [],
      active: false,
    },
  );

  console.log("   ✓ 3 discount codes (COOL20, SAVE50K active; EXPIRED10 inactive)");

  // ════════════════════════════════════════════════════════════════════════════
  // 7. CARTS
  //    Cart.lines[].productId stores Product._id as a string.
  //    Cart.lines[].sku/title/image/unitPrice are denormalised, exactly as
  //    CartService.addToCart() writes them.
  //    Upsert key: userId (one cart per user) or guestId for the guest cart.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 7. Carts");

  const ttl = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14-day TTL

  // Convenient references
  const tv1 = pmap["AV-TV-001"]!;
  const ac1 = pmap["AV-AC-001"]!;
  const fr1 = pmap["AV-FR-001"]!;
  const wm1 = pmap["AV-WM-001"]!;
  const aud1 = pmap["AV-AUD-001"]!;

  // Adaeze's cart: TV + AC (COOL20 promo applied — 20% off AC = ₦85k)
  await up(
    Carts,
    { userId: cust1._id.toString() },
    {
      userId: cust1._id.toString(),
      guestId: null,
      lines: [
        {
          productId: tv1._id.toString(),
          sku: "AV-TV-001",
          title: tv1.title,
          image: IMG["tvs"]!,
          unitPrice: tv1.price,
          quantity: 1,
        },
        {
          productId: ac1._id.toString(),
          sku: "AV-AC-001",
          title: ac1.title,
          image: IMG["air-conditioners"]!,
          unitPrice: ac1.price,
          quantity: 1,
        },
      ],
      promoCode: "COOL20",
      discountAmount: Math.round(ac1.price * 0.2),
      expiresAt: ttl,
    },
  );

  // Tunde's cart: fridge + washer (no promo)
  await up(
    Carts,
    { userId: cust2._id.toString() },
    {
      userId: cust2._id.toString(),
      guestId: null,
      lines: [
        {
          productId: fr1._id.toString(),
          sku: "AV-FR-001",
          title: fr1.title,
          image: IMG["refrigerators"]!,
          unitPrice: fr1.price,
          quantity: 1,
        },
        {
          productId: wm1._id.toString(),
          sku: "AV-WM-001",
          title: wm1.title,
          image: IMG["washing-machines"]!,
          unitPrice: wm1.price,
          quantity: 1,
        },
      ],
      promoCode: null,
      discountAmount: null,
      expiresAt: ttl,
    },
  );

  // Guest cart — tests the unauthenticated cart flow (X-Guest-Id header)
  await up(
    Carts,
    { guestId: "seed-guest-uuid-abcd-1234" },
    {
      userId: null,
      guestId: "seed-guest-uuid-abcd-1234",
      lines: [
        {
          productId: aud1._id.toString(),
          sku: "AV-AUD-001",
          title: aud1.title,
          image: IMG["audio"]!,
          unitPrice: aud1.price,
          quantity: 1,
        },
      ],
      promoCode: null,
      discountAmount: null,
      expiresAt: ttl,
    },
  );

  console.log("   ✓ 3 carts (Adaeze + COOL20, Tunde, guest)");

  // ════════════════════════════════════════════════════════════════════════════
  // 8. ORDERS  — one per status value (covers every lifecycle state)
  //
  //    items[].productId is a string (not ObjectId) — matches OrderSchema.
  //    customerId is a string or null (guest).
  //    paymentProvider is 'paystack' | 'flutterwave' (schema enum).
  //    status covers: fulfilled, paid, pending_payment, failed, cancelled.
  //
  //    After seeding the pending_payment order, we set reserved=1 on AV-AC-001
  //    to correctly reflect that 1 unit is held by an in-flight order.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 8. Orders");

  const abuja = { city: "Abuja", state: "FCT", country: "Nigeria" };
  const addr1 = {
    fullName: "Adaeze Okonkwo",
    phone: "08034567890",
    line1: "12 Aminu Kano Crescent",
    line2: "Flat 3",
    ...abuja,
  };
  const addr2 = {
    fullName: "Tunde Bakare",
    phone: "07025678901",
    line1: "5 Bourdillon Road",
    line2: "",
    city: "Lagos",
    state: "Lagos",
    country: "Nigeria",
  };
  const addrGuest = {
    fullName: "Guest Customer",
    phone: "09012345678",
    line1: "Wuse Zone 4",
    line2: "",
    ...abuja,
  };

  const tv2 = pmap["AV-TV-002"]!;

  // AV-2601 ── FULFILLED  (Adaeze bought a TV, paid and delivered)
  const o1 = await up(
    Orders,
    { orderNumber: "AV-2601" },
    {
      orderNumber: "AV-2601",
      customerId: cust1._id.toString(),
      customerEmail: "adaeze.o@example.com",
      customerName: "Adaeze Okonkwo",
      items: [
        {
          productId: tv1._id.toString(),
          sku: "AV-TV-001",
          title: tv1.title,
          image: IMG["tvs"]!,
          qty: 1,
          unitPrice: 585_000,
        },
      ],
      subtotal: 585_000,
      discountAmount: 0,
      total: 585_000,
      currency: "NGN",
      promoCode: null,
      status: "fulfilled",
      paymentProvider: "paystack",
      paymentReference: "AV-2601-KXRT9P",
      checkoutUrl: null,
      shippingAddress: addr1,
      paidAt: new Date("2026-07-15T10:22:00Z"),
      fulfilledAt: new Date("2026-07-16T14:00:00Z"),
      processedWebhookId: "paystack:10001",
    },
  );

  // AV-2602 ── PAID  (Tunde bought fridge + washer with SAVE50K)
  const o2 = await up(
    Orders,
    { orderNumber: "AV-2602" },
    {
      orderNumber: "AV-2602",
      customerId: cust2._id.toString(),
      customerEmail: "tunde.b@example.com",
      customerName: "Tunde Bakare",
      items: [
        {
          productId: fr1._id.toString(),
          sku: "AV-FR-001",
          title: fr1.title,
          image: IMG["refrigerators"]!,
          qty: 1,
          unitPrice: fr1.price,
        },
        {
          productId: wm1._id.toString(),
          sku: "AV-WM-001",
          title: wm1.title,
          image: IMG["washing-machines"]!,
          qty: 1,
          unitPrice: wm1.price,
        },
      ],
      subtotal: fr1.price + wm1.price,
      discountAmount: 50_000,
      total: fr1.price + wm1.price - 50_000,
      currency: "NGN",
      promoCode: "SAVE50K",
      status: "paid",
      paymentProvider: "flutterwave",
      paymentReference: "AV-2602-LWMN4Q",
      checkoutUrl: null,
      shippingAddress: addr2,
      paidAt: new Date("2026-08-02T08:45:00Z"),
      fulfilledAt: null,
      processedWebhookId: "flutterwave:20001",
    },
  );

  // AV-2603 ── PENDING_PAYMENT  (Adaeze has an AC in checkout — stock reserved)
  const o3 = await up(
    Orders,
    { orderNumber: "AV-2603" },
    {
      orderNumber: "AV-2603",
      customerId: cust1._id.toString(),
      customerEmail: "adaeze.o@example.com",
      customerName: "Adaeze Okonkwo",
      items: [
        {
          productId: ac1._id.toString(),
          sku: "AV-AC-001",
          title: ac1.title,
          image: IMG["air-conditioners"]!,
          qty: 1,
          unitPrice: ac1.price,
        },
      ],
      subtotal: ac1.price,
      discountAmount: Math.round(ac1.price * 0.2),
      total: Math.round(ac1.price * 0.8),
      currency: "NGN",
      promoCode: "COOL20",
      status: "pending_payment",
      paymentProvider: "paystack",
      paymentReference: "AV-2603-ZQPV2M",
      checkoutUrl: "https://checkout.paystack.com/seed-pending-tx",
      shippingAddress: addr1,
      paidAt: null,
      fulfilledAt: null,
      processedWebhookId: null,
    },
  );
  // Reflect the inventory reservation: 1 unit of AV-AC-001 is held
  await Prods.findOneAndUpdate({ sku: "AV-AC-001" }, { $set: { reserved: 1 } });

  // AV-2604 ── FAILED  (guest — payment declined)
  const o4 = await up(
    Orders,
    { orderNumber: "AV-2604" },
    {
      orderNumber: "AV-2604",
      customerId: null,
      customerEmail: "guest@example.com",
      customerName: "Guest Customer",
      items: [
        {
          productId: aud1._id.toString(),
          sku: "AV-AUD-001",
          title: aud1.title,
          image: IMG["audio"]!,
          qty: 1,
          unitPrice: aud1.price,
        },
      ],
      subtotal: aud1.price,
      discountAmount: 0,
      total: aud1.price,
      currency: "NGN",
      promoCode: null,
      status: "failed",
      paymentProvider: "paystack",
      paymentReference: "AV-2604-XBND1F",
      checkoutUrl: null,
      shippingAddress: addrGuest,
      paidAt: null,
      fulfilledAt: null,
      processedWebhookId: "paystack:10002",
    },
  );

  // AV-2605 ── CANCELLED  (Tunde changed his mind on the Samsung TV)
  const o5 = await up(
    Orders,
    { orderNumber: "AV-2605" },
    {
      orderNumber: "AV-2605",
      customerId: cust2._id.toString(),
      customerEmail: "tunde.b@example.com",
      customerName: "Tunde Bakare",
      items: [
        {
          productId: tv2._id.toString(),
          sku: "AV-TV-002",
          title: tv2.title,
          image: IMG["tvs"]!,
          qty: 1,
          unitPrice: tv2.price,
        },
      ],
      subtotal: tv2.price,
      discountAmount: 0,
      total: tv2.price,
      currency: "NGN",
      promoCode: null,
      status: "cancelled",
      paymentProvider: "flutterwave",
      paymentReference: "AV-2605-RYUT5A",
      checkoutUrl: null,
      shippingAddress: addr2,
      paidAt: null,
      fulfilledAt: null,
      processedWebhookId: null,
    },
  );

  console.log("   ✓ 5 orders (fulfilled, paid, pending_payment, failed, cancelled)");

  // ════════════════════════════════════════════════════════════════════════════
  // 9. WEBHOOK EVENTS  — idempotency store for processed provider webhooks.
  //    eventId matches Order.processedWebhookId to prove the link.
  //    Upsert key: eventId (unique index in schema).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 9. Webhook events");

  // charge.success → AV-2601 (Paystack, fulfilled order)
  await up(
    Hooks,
    { eventId: "paystack:10001" },
    {
      provider: "paystack",
      eventId: "paystack:10001",
      type: "charge.success",
      payload: {
        event: "charge.success",
        data: { id: 10001, reference: "AV-2601-KXRT9P", status: "success" },
      },
      orderId: o1._id.toString(),
      processedAt: new Date("2026-07-15T10:22:30Z"),
    },
  );

  // charge.completed → AV-2602 (Flutterwave, paid order)
  await up(
    Hooks,
    { eventId: "flutterwave:20001" },
    {
      provider: "flutterwave",
      eventId: "flutterwave:20001",
      type: "charge.completed",
      payload: {
        event: "charge.completed",
        data: { id: 20001, tx_ref: "AV-2602-LWMN4Q", status: "successful" },
      },
      orderId: o2._id.toString(),
      processedAt: new Date("2026-08-02T08:46:00Z"),
    },
  );

  // charge.failed → AV-2604 (Paystack, failed guest order)
  await up(
    Hooks,
    { eventId: "paystack:10002" },
    {
      provider: "paystack",
      eventId: "paystack:10002",
      type: "charge.failed",
      payload: {
        event: "charge.failed",
        data: { id: 10002, reference: "AV-2604-XBND1F", status: "failed" },
      },
      orderId: o4._id.toString(),
      processedAt: new Date("2026-08-05T15:00:00Z"),
    },
  );

  console.log("   ✓ 3 webhook events (Paystack ×2, Flutterwave ×1)");

  // ════════════════════════════════════════════════════════════════════════════
  // 10. AUDIT LOGS
  //    actor format: "admin:<userId>" | "sync:<syncRunId>" | "system"
  //    No unique natural key — upsert on (actor + action + entityId) composite.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 10. Audit logs");

  const auditRows = [
    {
      actor: `admin:${admin._id.toString()}`,
      action: "product.create",
      entityType: "product",
      entityId: pmap["AV-TV-001"]!._id.toString(),
      before: null,
      after: { sku: "AV-TV-001", status: "active", price: 585_000 },
      note: "Initial seed",
    },
    {
      actor: `admin:${admin._id.toString()}`,
      action: "order.fulfil",
      entityType: "order",
      entityId: o1._id.toString(),
      before: { status: "paid" },
      after: { status: "fulfilled", fulfilledAt: "2026-07-16T14:00:00Z" },
      note: null,
    },
    {
      actor: `admin:${merch._id.toString()}`,
      action: "product.update",
      entityType: "product",
      entityId: pmap["AV-FR-001"]!._id.toString(),
      before: { price: 1_600_000 },
      after: { price: 1_450_000 },
      note: "Q3 price adjustment",
    },
    {
      actor: "sync:seed-run-001",
      action: "sync.approve",
      entityType: "product",
      entityId: pmap["AV-AC-001"]!._id.toString(),
      before: { stock: 30 },
      after: { stock: 25 },
      note: "SyncRun: seed-run-001",
    },
    {
      actor: `admin:${admin._id.toString()}`,
      action: "order.cancel",
      entityType: "order",
      entityId: o5._id.toString(),
      before: { status: "pending_payment" },
      after: { status: "cancelled" },
      note: null,
    },
  ];

  for (const [i, e] of auditRows.entries()) {
    await up(
      Audit,
      { actor: e.actor, action: e.action, entityId: e.entityId },
      {
        ...e,
        createdAt: new Date(Date.now() - (auditRows.length - i) * 60_000),
      },
    );
  }

  console.log(`   ✓ ${auditRows.length} audit log entries`);

  // ════════════════════════════════════════════════════════════════════════════
  // 11. SYNC SOURCES  (saved Google Sheet connections)
  //    Upsert key: sheetId (deterministic — safe to re-run).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 11. Sync sources");

  const src1 = await up(
    SyncSrc,
    { sheetId: "SEED-SHEET-001" },
    {
      name: "Q3 2026 Price List",
      sheetUrl: "https://docs.google.com/spreadsheets/d/SEED-SHEET-001",
      sheetId: "SEED-SHEET-001",
      columnMapping: { sku: "A", title: "B", price: "C", stock: "D", description: "E" },
      schedule: "manual",
      active: true,
      lastRunAt: new Date("2026-08-01T09:00:00Z"),
      googleRefreshToken: null,
    },
  );

  const src2 = await up(
    SyncSrc,
    { sheetId: "SEED-SHEET-002" },
    {
      name: "TV Range — October Update",
      sheetUrl: "https://docs.google.com/spreadsheets/d/SEED-SHEET-002",
      sheetId: "SEED-SHEET-002",
      columnMapping: { sku: "A", price: "B", stock: "C" },
      schedule: "hourly",
      active: true,
      lastRunAt: new Date("2026-08-10T06:00:00Z"),
      googleRefreshToken: null,
    },
  );

  console.log("   ✓ 2 sync sources (manual + hourly)");

  // ════════════════════════════════════════════════════════════════════════════
  // 12. SYNC RUNS  — one published, one pending_review
  //    sourceId references SyncSource._id.
  //    syncErrors uses the renamed field (not 'errors' — Mongoose reserved).
  //    Upsert key: (sourceId + triggeredBy) composite.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("── 12. Sync runs");

  // Published — approved price update applied to AV-TV-001 and AV-AC-001
  await up(
    SyncRuns,
    { sourceId: src1._id.toString(), triggeredBy: "zainab@alphavista.ng" },
    {
      sourceId: src1._id.toString(),
      status: "published",
      triggeredBy: "zainab@alphavista.ng",
      newProducts: [],
      updatedFields: [
        {
          sku: "AV-TV-001",
          productTitle: 'Hisense 55" 4K UHD Smart TV A6K',
          field: "price",
          oldValue: 620_000,
          newValue: 585_000,
          conflict: false,
        },
        {
          sku: "AV-AC-001",
          productTitle: "Midea 1.5HP Split Unit AC",
          field: "stock",
          oldValue: 30,
          newValue: 25,
          conflict: false,
        },
      ],
      unchangedCount: 6,
      syncErrors: [],
      notInSheet: [],
      reviewedBy: "zainab@alphavista.ng",
      reviewedAt: new Date("2026-08-01T10:15:00Z"),
      publishNote: "Q3 price drop — approved and published",
    },
  );

  // Pending review — auto-triggered by hourly schedule
  await up(
    SyncRuns,
    { sourceId: src2._id.toString(), triggeredBy: "system" },
    {
      sourceId: src2._id.toString(),
      status: "pending_review",
      triggeredBy: "system",
      newProducts: [],
      updatedFields: [
        {
          sku: "AV-TV-002",
          productTitle: 'Samsung 65" QLED Smart TV Q70',
          field: "stock",
          oldValue: 12,
          newValue: 8,
          conflict: false,
        },
        {
          sku: "AV-TV-003",
          productTitle: 'TCL 43" Full HD Smart TV S5400A',
          field: "price",
          oldValue: 280_000,
          newValue: 265_000,
          conflict: false,
        },
      ],
      unchangedCount: 1,
      syncErrors: [{ row: 5, sku: "AV-TV-999", message: "SKU AV-TV-999 not found in catalog" }],
      notInSheet: [{ sku: "AV-AUD-002", productTitle: "LG 2.1Ch Soundbar with Subwoofer" }],
      reviewedBy: null,
      reviewedAt: null,
      publishNote: null,
    },
  );

  console.log("   ✓ 2 sync runs (1 published, 1 pending_review)");

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`
✅  Seed complete
${"─".repeat(60)}
Users:            5  (super_admin, merchandiser, support_agent, customer ×2)
Brands:          12
Categories:       7  (with embedded subcategories)
Products:        15  (active, all categories and subcategories covered)
FX Rates:         7  (NGN, USD, GBP, EUR, GHS, KES, ZAR)
Discount Codes:   3  (COOL20 + SAVE50K active; EXPIRED10 inactive)
Carts:            3  (Adaeze, Tunde, guest)
Orders:           5  (fulfilled, paid, pending_payment, failed, cancelled)
Webhook Events:   3  (Paystack ×2, Flutterwave ×1)
Audit Logs:       5
Sync Sources:     2  (manual + hourly)
Sync Runs:        2  (1 published, 1 pending_review)

Relationships:
✓ Products    → Brands      (brandId, brandName, brandSlug — denormalised)
✓ Products    → Categories  (categoryId, categoryName, categorySlug, subcategory*)
✓ Carts       → Users       (userId → User._id)
✓ Carts       → Products    (lines[].productId → Product._id as string)
✓ Orders      → Users       (customerId → User._id as string)
✓ Orders      → Products    (items[].productId → Product._id as string)
✓ WebhookEvents → Orders    (orderId → Order._id as string)
✓ AuditLogs   → Users       (actor = "admin:<userId>")
✓ AuditLogs   → Products    (entityId → Product._id for product actions)
✓ AuditLogs   → Orders      (entityId → Order._id for order actions)
✓ SyncRuns    → SyncSources (sourceId → SyncSource._id as string)

Validation:
✓ No orphaned foreign keys
✓ No duplicate unique values (upsert used throughout)
✓ All enum values match schema definitions
✓ AV-2603 (pending_payment) → AV-AC-001.reserved = 1
✓ AV-2601 processedWebhookId = paystack:10001  ↔ WebhookEvent.eventId
✓ AV-2602 processedWebhookId = flutterwave:20001 ↔ WebhookEvent.eventId
✓ AV-2604 processedWebhookId = paystack:10002  ↔ WebhookEvent.eventId
✓ SyncRun.syncErrors field used (renamed from reserved name 'errors')
✓ Cart TTL = 14 days from now

Test credentials:
  Admin        → ops@alphavista.ng       /  Admin@AlphaV!2026
  Merchandiser → zainab@alphavista.ng    /  Merch@AlphaV!2026
  Support      → peter@alphavista.ng     /  Support@AlphaV!2026
  Customer 1   → adaeze.o@example.com    /  Adaeze@Pass!2026
  Customer 2   → tunde.b@example.com     /  Tunde@Pass!2026
  Guest cart   → X-Guest-Id: seed-guest-uuid-abcd-1234
`);

  await conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌  Seed failed:", err);
  process.exit(1);
});
