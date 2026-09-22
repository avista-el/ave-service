import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/mongoose";
import { Model, Connection, Types } from "mongoose";
import { Order, OrderDocument, OrderStatus } from "./schemas/order.schema";
import { Cart, CartDocument } from "../cart/schemas/cart.schema";
import { InventoryService } from "../inventory/inventory.service";
import { PriceResolutionService } from "../promotions/price-resolution.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";

@Injectable()
export class OrderService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly inventoryService: InventoryService,
    private readonly priceResolution: PriceResolutionService,
  ) {}

  // ─── Create order + reserve stock atomically ──────────────────────────────

  async createOrder(dto: CreateOrderDto, userId: string | null): Promise<OrderDocument> {
    // 1. Resolve cart
    let cart: CartDocument | null = null;
    if (dto.cartId) {
      cart = await this.cartModel.findById(dto.cartId);
    } else if (userId) {
      cart = await this.cartModel.findOne({ userId });
    }
    if (!cart || cart.lines.length === 0) {
      throw new BadRequestException("Cart is empty or not found");
    }

    // 2. Re-validate prices server-side.
    //
    //    The server is the source of truth — we never trust cart.unitPrice.
    //    For each line we:
    //      a) fetch the live product document
    //      b) run resolveEffectivePrice (auto-apply OR coupon, same function
    //         used by the storefront display)
    //      c) use the server-computed unitPrice for order totals
    //
    //    If an auto-apply discount is active AND the cart carries a promoCode,
    //    resolveEffectivePrice throws ConflictException — the caller must
    //    either remove the coupon or the auto-apply will take precedence.
    const couponCode = cart.promoCode ?? undefined;

    const productIds = cart.lines.map((l) => l.productId);
    const products = await this.productModel
      .find({ _id: { $in: productIds.map((id) => new Types.ObjectId(id)) } })
      .lean<(ProductDocument & { _id: Types.ObjectId })[]>();

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const items: {
      productId: string;
      sku: string;
      title: string;
      image: string;
      qty: number;
      unitPrice: number;
    }[] = [];

    for (const line of cart.lines) {
      const product = productMap.get(line.productId);
      if (!product) {
        throw new BadRequestException(`Product "${line.title}" is no longer available`);
      }
      if (product.status !== "active") {
        throw new BadRequestException(`"${product.title}" is no longer available for purchase`);
      }

      // resolveEffectivePrice is the single source of truth for price — same
      // function used by CatalogService for storefront display.
      const resolved = await this.priceResolution.resolveEffectivePrice(
        {
          _id: product._id,
          price: product.price,
          categorySlug: product.categorySlug,
          subcategorySlug: product.subcategorySlug ?? undefined,
        },
        couponCode,
      );

      items.push({
        productId: line.productId,
        sku: product.sku,
        title: product.title,
        image: product.images[0] ?? "",
        qty: line.quantity,
        unitPrice: resolved.effectivePrice,
      });
    }

    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);

    // Coupon discount is now baked into per-item unitPrices via resolveEffectivePrice.
    // discountAmount on the order is kept at 0 to avoid double-counting.
    // The promoCode field is preserved for audit/reporting purposes.
    const total = subtotal;

    // 3. Reserve stock + create order in a single Mongo transaction
    const session = await this.connection.startSession();
    let order: OrderDocument;
    try {
      await session.withTransaction(async () => {
        for (const item of items) {
          await this.inventoryService.reserveStock(item.productId, item.qty, session);
        }

        const orderNumber = await this.nextOrderNumber();
        const paymentReference = this.generateReference(orderNumber);

        [order] = await this.orderModel.create(
          [
            {
              orderNumber,
              customerId: userId,
              customerEmail: dto.customerEmail ?? null,
              customerName: dto.customerName ?? null,
              items,
              subtotal,
              promoCode: cart!.promoCode ?? null,
              discountAmount: 0, // baked into unit prices; kept for schema compat
              total,
              paymentProvider: dto.paymentProvider,
              paymentReference,
              shippingAddress: dto.shippingAddress,
              status: "pending_payment",
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    return order!;
  }

  // ─── State transitions (called by PaymentModule webhook handler) ──────────

  async markPaid(orderId: string, webhookId: string, session?: unknown): Promise<OrderDocument> {
    const order = await this.orderModel.findByIdAndUpdate(
      orderId,
      {
        status: "paid",
        paidAt: new Date(),
        processedWebhookId: webhookId,
      },
      { new: true },
    );
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async markFailed(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId);
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "pending_payment") return order;

    for (const item of order.items) {
      await this.inventoryService.releaseStock(item.productId, item.qty);
    }

    order.status = "failed";
    return order.save();
  }

  async markAbandoned(orderId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId);
    if (!order || order.status !== "pending_payment") return;
    await this.inventoryService.releaseStockBatch(
      order.items.map((i) => ({ productId: i.productId, qty: i.qty })),
    );
    order.status = "abandoned";
    await order.save();
  }

  async markFulfilled(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findByIdAndUpdate(
      orderId,
      { status: "fulfilled", fulfilledAt: new Date() },
      { new: true },
    );
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async markCancelled(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId);
    if (!order) throw new NotFoundException("Order not found");
    if (["paid", "fulfilled"].includes(order.status)) {
      throw new BadRequestException(
        "Cannot cancel a paid or fulfilled order — issue a refund instead",
      );
    }
    if (order.status === "pending_payment") {
      await this.inventoryService.releaseStockBatch(
        order.items.map((i) => ({ productId: i.productId, qty: i.qty })),
      );
    }
    order.status = "cancelled";
    return order.save();
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async findByReference(ref: string): Promise<OrderDocument | null> {
    return this.orderModel.findOne({ paymentReference: ref });
  }

  async findById(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id);
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async findByCustomer(userId: string, pagination: PaginationDto) {
    const filter = { customerId: userId };
    const [items, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit ?? 20)
        .lean(),
      this.orderModel.countDocuments(filter),
    ]);
    return paginate(items.map(this.withId), total, pagination);
  }

  async findAll(pagination: PaginationDto, status?: OrderStatus) {
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit ?? 20)
        .lean(),
      this.orderModel.countDocuments(filter),
    ]);
    return paginate(items.map(this.withId), total, pagination);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Lean documents don't have the Mongoose virtual `id` getter, so the
   * frontend's ApiOrder.id would be undefined and calls like
   * `cancel.mutateAsync(order.id)` would send "/admin/orders/undefined/cancel".
   * This helper adds an explicit `id` string field to every lean result.
   */
  private withId = <T extends { _id: unknown }>(doc: T): T & { id: string } => ({
    ...doc,
    id: (doc._id as Types.ObjectId).toString(),
  });

  private async nextOrderNumber(): Promise<string> {
    const last = await this.orderModel
      .findOne()
      .sort({ createdAt: -1 })
      .select("orderNumber")
      .lean();
    const lastNum = last ? parseInt(last.orderNumber.replace("AV-", ""), 10) : 2600;
    return `AV-${lastNum + 1}`;
  }

  private generateReference(orderNumber: string): string {
    const ts = Date.now().toString(36).toUpperCase();
    return `${orderNumber}-${ts}`;
  }

  /** Called by reconciliation BullMQ job to find stale pending_payment orders */
  async findStalePendingOrders(olderThanMinutes: number): Promise<OrderDocument[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return this.orderModel.find({
      status: "pending_payment",
      createdAt: { $lt: cutoff },
    });
  }
}
