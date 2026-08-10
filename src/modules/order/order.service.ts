import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel, InjectConnection } from "@nestjs/mongoose";
import { Model, Connection, Types } from "mongoose";
import { Order, OrderDocument, OrderStatus } from "./schemas/order.schema";
import { Cart, CartDocument } from "../cart/schemas/cart.schema";
import { InventoryService } from "../inventory/inventory.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";

@Injectable()
export class OrderService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly inventoryService: InventoryService,
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

    // 2. Build order items from cart lines
    const items = cart.lines.map((l) => ({
      productId: l.productId,
      sku: l.sku,
      title: l.title,
      image: l.image,
      qty: l.quantity,
      unitPrice: l.unitPrice,
    }));
    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    const discount = cart.discountAmount ?? 0;
    const total = Math.max(0, subtotal - discount);

    // 3. Reserve stock + create order in a single Mongo transaction
    const session = await this.connection.startSession();
    let order: OrderDocument;
    try {
      await session.withTransaction(async () => {
        // Atomic stock reservation per item
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
              discountAmount: discount,
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

    // Release reserved stock
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
    return paginate(items, total, pagination);
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
    return paginate(items, total, pagination);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
