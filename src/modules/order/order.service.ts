import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel, InjectConnection } from "@nestjs/mongoose";
import { Model, Connection, Types } from "mongoose";
import * as crypto from "crypto";
import {
  Order,
  OrderDocument,
  OrderStatus,
  FailureCode,
  ACCESS_TOKEN_MAX_STORED,
} from "./schemas/order.schema";
import { Cart, CartDocument } from "../cart/schemas/cart.schema";
import { InventoryService } from "../inventory/inventory.service";
import { PriceResolutionService } from "../promotions/price-resolution.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";

/** Minutes the reservation is held for a gateway order. Env: ORDER_HOLD_MINUTES */
const DEFAULT_HOLD_MINUTES = 30;

/** Raw-token → gateway failure-reason → FailureCode mapping */
const FAILURE_CODE_MAP: { patterns: RegExp[]; code: FailureCode }[] = [
  { patterns: [/insufficient/i, /funds/i, /balance/i], code: "INSUFFICIENT_FUNDS" },
  { patterns: [/timeout/i, /timed out/i], code: "TIMEOUT" },
  { patterns: [/cancel/i, /user.*cancel/i, /abandoned/i], code: "CANCELLED_BY_USER" },
  { patterns: [/declin/i, /invalid/i, /not.*authoris/i, /not.*authoriz/i], code: "DECLINED" },
];

function mapFailureReason(raw: string | null | undefined): FailureCode {
  if (!raw) return "UNKNOWN";
  for (const { patterns, code } of FAILURE_CODE_MAP) {
    if (patterns.some((r) => r.test(raw))) return code;
  }
  return "UNKNOWN";
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  private readonly holdMinutes: number;

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly inventoryService: InventoryService,
    private readonly priceResolution: PriceResolutionService,
    private readonly config: ConfigService,
  ) {
    this.holdMinutes = this.config.get<number>("order.holdMinutes") ?? DEFAULT_HOLD_MINUTES;
  }

  // ─── Create order + reserve stock atomically ──────────────────────────────

  async createOrder(dto: CreateOrderDto, userId: string | null): Promise<OrderDocument> {
    const isGuest = !userId;

    // A. For guest orders, email is mandatory (enforced at DTO level too,
    //    but we double-check here so the service is self-consistent).
    if (isGuest && !dto.customerEmail) {
      throw new BadRequestException("customerEmail is required for guest orders");
    }

    // B. BNPL is not available to guests.
    if (isGuest && dto.paymentMethod === "installment") {
      throw new ForbiddenException({
        code: "ACCOUNT_REQUIRED",
        message: "Pay Small Small requires a registered account",
      });
    }

    // C. POD requires a phone number (already enforced by ShippingAddressDto,
    //    but surface a clearer message here).
    if (dto.paymentMethod === "pay_on_delivery" && !dto.shippingAddress?.phone) {
      throw new BadRequestException("Phone number is required for Pay on Delivery orders");
    }

    // 1. Resolve cart
    let cart: CartDocument | null = null;
    if (dto.cartId) {
      cart = await this.cartModel.findById(dto.cartId);
    } else if (userId) {
      cart = await this.cartModel.findOne({ userId });
    } else if (dto.guestId) {
      cart = await this.cartModel.findOne({ guestId: dto.guestId });
    }
    if (!cart || cart.lines.length === 0) {
      throw new BadRequestException("Cart is empty or not found");
    }

    // 2. Server-side price revalidation
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
    const total = subtotal;

    // 3. Reserve stock + create order in a single Mongo transaction
    const isGatewayOrder =
      dto.paymentMethod === "paystack" ||
      dto.paymentMethod === "flutterwave" ||
      dto.paymentMethod === "installment";

    const reservationExpiresAt = isGatewayOrder
      ? new Date(Date.now() + this.holdMinutes * 60 * 1000)
      : null;

    const isGateway = dto.paymentMethod === "paystack" || dto.paymentMethod === "flutterwave";
    const paymentProvider = isGateway
      ? dto.paymentMethod
      : dto.paymentMethod === "installment"
        ? "paystack"
        : null;

    const initialStatus =
      dto.paymentMethod === "pay_on_delivery" ? "awaiting_delivery_payment" : "pending_payment";

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
              discountAmount: 0,
              total,
              paymentMethod: dto.paymentMethod,
              paymentProvider,
              paymentReference,
              shippingAddress: dto.shippingAddress,
              status: initialStatus,
              reservationExpiresAt,
              // paymentAttempts: first entry pushed after initializePayment is called
              // (reference is not known yet for gateway orders)
              paymentAttempts: [],
              accessTokens: [],
              sentEmails: {},
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    this.logger.log({
      event: "order_created",
      orderNumber: order!.orderNumber,
      status: order!.status,
      paymentMethod: dto.paymentMethod,
      isGuest,
      reservationExpiresAt,
    });

    return order!;
  }

  // ─── Guest access tokens ──────────────────────────────────────────────────

  /**
   * Creates a cryptographically random 32-byte token, stores only its
   * SHA-256 hash on the order (max 10 most recent), and returns the RAW token.
   * Never call this in a context where the raw token would be logged.
   */
  async issueAccessToken(orderId: string): Promise<string> {
    const rawBytes = crypto.randomBytes(32);
    const rawToken = rawBytes.toString("base64url");
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    // Push new token; keep only the 10 most recent (oldest first → slice from front)
    await this.orderModel.findByIdAndUpdate(orderId, {
      $push: {
        accessTokens: {
          $each: [{ hash, expiresAt }],
          $slice: -10, // keep last 10
        },
      },
    });

    return rawToken;
  }

  /**
   * Constant-time token verification.
   * Returns true only if a non-expired token matching the raw value exists.
   * Always does the same amount of work regardless of outcome to prevent
   * timing-based enumeration.
   */
  async verifyAccessToken(order: OrderDocument, rawToken: string): Promise<boolean> {
    const incomingHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const now = new Date();

    let matched = false;
    for (const stored of order.accessTokens) {
      if (stored.expiresAt < now) continue;
      // timingSafeEqual requires equal-length Buffers
      const storedBuf = Buffer.from(stored.hash, "hex");
      const incomingBuf = Buffer.from(incomingHash, "hex");
      if (storedBuf.length === incomingBuf.length) {
        if (crypto.timingSafeEqual(storedBuf, incomingBuf)) {
          matched = true;
          // Do NOT break — continue to prevent early-exit timing leak
        }
      }
    }
    return matched;
  }

  // ─── State transitions ────────────────────────────────────────────────────

  async markPaid(orderId: string, webhookId: string): Promise<OrderDocument> {
    // findOneAndUpdate on expected prior status so duplicate webhooks
    // cannot double-process (idempotent CAS pattern).
    const order = await this.orderModel.findOneAndUpdate(
      { _id: orderId, status: { $in: ["pending_payment", "in_installments"] } },
      {
        status: "paid",
        paidAt: new Date(),
        processedWebhookId: webhookId,
      },
      {
        new: true,
      },
    );
    if (!order) {
      // Either not found or already in a terminal state — safe to ignore
      this.logger.warn({ event: "mark_paid_no_op", orderId, webhookId });
      const existing = await this.orderModel.findById(orderId);
      if (!existing) throw new NotFoundException("Order not found");
      return existing;
    }
    this.logger.log({ event: "order_paid", orderNumber: order.orderNumber, webhookId });
    return order;
  }

  /**
   * Mark a specific payment attempt as FAILED.
   * Does NOT release stock — the reservation stays alive until
   * reservationExpiresAt so the customer can retry.
   * Only transitions the order to 'failed' once the hold window has expired
   * (handled by the expiry processor calling markAbandoned).
   */
  async markFailedAttempt(opts: {
    reference: string;
    rawFailureReason?: string;
  }): Promise<OrderDocument | null> {
    const order = await this.findByAnyReference(opts.reference);
    if (!order) {
      this.logger.warn({ event: "failed_attempt_no_order", reference: opts.reference });
      return null;
    }

    const failureCode = mapFailureReason(opts.rawFailureReason);

    // Update the matching attempt in paymentAttempts using arrayFilters
    const updated = await this.orderModel.findOneAndUpdate(
      {
        _id: order._id,
        status: "pending_payment",
        "paymentAttempts.reference": opts.reference,
      },
      {
        $set: {
          "paymentAttempts.$[att].status": "FAILED",
          "paymentAttempts.$[att].failureCode": failureCode,
          // rawFailureReason is intentionally omitted from logs below
          "paymentAttempts.$[att].rawFailureReason": opts.rawFailureReason ?? null,
        },
      },
      {
        new: true,
        arrayFilters: [{ "att.reference": opts.reference }],
      },
    );

    if (updated) {
      this.logger.log({
        event: "payment_attempt_failed",
        orderNumber: updated.orderNumber,
        failureCode,
        // Note: rawFailureReason deliberately not logged
      });
    }

    return updated;
  }

  /**
   * Kept for backward compat — called by legacy paths that still use the old
   * markFailed name. Routes through markFailedAttempt internally.
   * @deprecated Prefer markFailedAttempt directly.
   */
  async markFailed(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId);
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "pending_payment") return order;

    // Find the most recent INITIATED attempt and mark it failed
    const latestRef = [...(order.paymentAttempts ?? [])]
      .reverse()
      .find((a) => a.status === "INITIATED")?.reference;

    if (latestRef) {
      return (await this.markFailedAttempt({ reference: latestRef })) ?? order;
    }
    return order;
  }

  async markAbandoned(orderId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId);
    if (!order || order.status !== "pending_payment") return;
    await this.inventoryService.releaseStockBatch(
      order.items.map((i) => ({ productId: i.productId, qty: i.qty })),
    );
    order.status = "abandoned";
    await order.save();
    this.logger.log({ event: "order_abandoned", orderNumber: order.orderNumber });
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
    if (["pending_payment", "awaiting_delivery_payment"].includes(order.status)) {
      await this.inventoryService.releaseStockBatch(
        order.items.map((i) => ({ productId: i.productId, qty: i.qty })),
      );
    }
    order.status = "cancelled";
    this.logger.log({ event: "order_cancelled", orderNumber: order.orderNumber });
    return order.save();
  }

  /**
   * Customer/guest-initiated cancel for a *paid* order.
   * Does NOT cancel the order — sets cancellationRequestedAt so support
   * can action it and trigger a manual refund.
   * Returns 202-style data; controller decides the HTTP status.
   */
  async requestCancellation(opts: {
    orderNumber: string;
    reason?: string;
    rawToken?: string;
    userId?: string;
  }): Promise<{ status: "pending_review"; orderNumber: string }> {
    const order = await this.findByOrderNumber(opts.orderNumber);

    // Auth: either the order's customerId matches, or the guest token is valid
    if (opts.userId) {
      if (order.customerId !== opts.userId) throw new NotFoundException("Order not found");
    } else if (opts.rawToken) {
      const valid = await this.verifyAccessToken(order, opts.rawToken);
      if (!valid) throw new NotFoundException("Order not found");
    } else {
      throw new NotFoundException("Order not found");
    }

    if (["pending_payment", "awaiting_delivery_payment"].includes(order.status)) {
      // Can cancel outright
      await this.markCancelled((order._id as Types.ObjectId).toString());
      return { status: "pending_review", orderNumber: order.orderNumber };
    }

    if (order.status === "paid") {
      if (order.cancellationRequestedAt) {
        // Already requested — idempotent
        return { status: "pending_review", orderNumber: order.orderNumber };
      }
      await this.orderModel.findByIdAndUpdate(order._id, {
        cancellationRequestedAt: new Date(),
        cancellationReason: opts.reason ?? null,
      });
      this.logger.log({
        event: "cancellation_requested",
        orderNumber: order.orderNumber,
        // reason deliberately not logged in full — may contain PII
      });
      return { status: "pending_review", orderNumber: order.orderNumber };
    }

    throw new ConflictException({
      code: "INVALID_STATUS",
      message: `Order cannot be cancelled in status: ${order.status}`,
    });
  }

  // ─── Payment: success with amount check ──────────────────────────────────

  /**
   * Marks order paid after verifying the charged amount and currency match.
   * If they don't match: flags needsAmountReview, sets paidAt, does NOT
   * commit stock, returns { mismatch: true }.
   */
  async markPaidWithAmountCheck(opts: {
    orderId: string;
    webhookId: string;
    paidAmountNgn: number;
    currency: string;
    reference: string;
  }): Promise<{ mismatch: boolean; order: OrderDocument }> {
    const order = await this.orderModel.findById(opts.orderId);
    if (!order) throw new NotFoundException("Order not found");

    // Allow a 1-kobo rounding tolerance
    const amountMatches =
      opts.currency.toUpperCase() === "NGN" && Math.abs(opts.paidAmountNgn - order.total) <= 1;

    if (!amountMatches) {
      this.logger.warn({
        event: "payment_amount_mismatch",
        orderNumber: order.orderNumber,
        expected: order.total,
        received: opts.paidAmountNgn,
        currency: opts.currency,
        // webhookId and reference deliberately omitted from warn to avoid leaking in logs
      });

      const flagged = await this.orderModel.findOneAndUpdate(
        { _id: opts.orderId, status: "pending_payment" },
        {
          needsAmountReview: true,
          paidAt: new Date(),
          processedWebhookId: opts.webhookId,
        },
        { new: true },
      );
      return { mismatch: true, order: flagged ?? order };
    }

    // Amount OK — normal paid transition
    const paid = await this.markPaid(opts.orderId, opts.webhookId);
    // Mark the matching attempt as SUCCESS
    await this.orderModel.findOneAndUpdate(
      { _id: opts.orderId, "paymentAttempts.reference": opts.reference },
      { $set: { "paymentAttempts.$[att].status": "SUCCESS" } },
      { arrayFilters: [{ "att.reference": opts.reference }] },
    );
    return { mismatch: false, order: paid };
  }

  // ─── Late payment (payment arrives after stock was released) ─────────────

  /**
   * Called when a success event arrives for an order in a terminal released-
   * stock state (failed, abandoned, cancelled).
   * Attempts to re-reserve stock in a transaction:
   *   - success → marks paid, commits stock
   *   - failure → sets refund_required, records paidAt, emails customer
   */
  async handleLatePayment(opts: {
    orderId: string;
    webhookId: string;
    paidAmountNgn: number;
    currency: string;
    reference: string;
  }): Promise<{ reserved: boolean; order: OrderDocument }> {
    const order = await this.orderModel.findById(opts.orderId);
    if (!order) throw new NotFoundException("Order not found");

    this.logger.warn({
      event: "late_payment_attempt",
      orderNumber: order.orderNumber,
      priorStatus: order.status,
    });

    // Amount check first — even for late payments
    const amountMatches =
      opts.currency.toUpperCase() === "NGN" && Math.abs(opts.paidAmountNgn - order.total) <= 1;

    if (!amountMatches) {
      this.logger.warn({
        event: "late_payment_amount_mismatch",
        orderNumber: order.orderNumber,
      });
      const flagged = await this.orderModel.findOneAndUpdate(
        { _id: opts.orderId },
        { needsAmountReview: true, paidAt: new Date() },
        { new: true },
      );
      return { reserved: false, order: flagged ?? order };
    }

    // Try to re-reserve stock in a transaction
    const session = await this.connection.startSession();
    let reserved = false;
    let resultOrder: OrderDocument = order;

    try {
      await session.withTransaction(async () => {
        for (const item of order.items) {
          await this.inventoryService.reserveStock(item.productId, item.qty, session);
        }
        // If we get here, all reservations succeeded
        reserved = true;

        // Commit immediately
        for (const item of order.items) {
          await this.inventoryService.commitReservedStock(item.productId, item.qty, session);
        }

        resultOrder = (await this.orderModel.findOneAndUpdate(
          { _id: opts.orderId },
          {
            status: "paid",
            paidAt: new Date(),
            processedWebhookId: opts.webhookId,
          },
          { new: true, session },
        )) as OrderDocument;
      });
    } catch {
      // reserveStock threw ConflictException — stock genuinely unavailable
      reserved = false;
      resultOrder = (await this.orderModel.findOneAndUpdate(
        { _id: opts.orderId },
        {
          status: "refund_required",
          paidAt: new Date(),
          processedWebhookId: opts.webhookId,
        },
        { new: true },
      )) as OrderDocument;

      this.logger.warn({
        event: "late_payment_stock_unavailable_refund_required",
        orderNumber: order.orderNumber,
      });
    } finally {
      await session.endSession();
    }

    return { reserved, order: resultOrder };
  }

  // ─── Retry payment ────────────────────────────────────────────────────────

  /**
   * Pushes a new INITIATED payment attempt for a pending_payment order.
   * If reservationExpiresAt has passed, tries to re-reserve stock first.
   * Returns the new paymentReference to use for initializePayment.
   * Caller is responsible for extending reservationExpiresAt.
   */
  async prepareRetryPayment(opts: {
    orderNumber: string;
    provider: "paystack" | "flutterwave";
    rawToken?: string;
    userId?: string;
  }): Promise<{ order: OrderDocument; newReference: string }> {
    const order = await this.findByOrderNumber(opts.orderNumber);

    // Auth
    if (opts.userId) {
      if (order.customerId !== opts.userId) throw new NotFoundException("Order not found");
    } else if (opts.rawToken) {
      const valid = await this.verifyAccessToken(order, opts.rawToken);
      if (!valid) throw new NotFoundException("Order not found");
    } else {
      throw new NotFoundException("Order not found");
    }

    if (order.status !== "pending_payment") {
      throw new ConflictException({
        code: "INVALID_STATUS",
        message: `Order is not awaiting payment — status: ${order.status}`,
      });
    }

    const now = new Date();
    const holdExpired = order.reservationExpiresAt !== null && order.reservationExpiresAt < now;

    if (holdExpired) {
      // Try to re-reserve
      const session = await this.connection.startSession();
      try {
        await session.withTransaction(async () => {
          for (const item of order.items) {
            await this.inventoryService.reserveStock(item.productId, item.qty, session);
          }
        });
      } catch {
        throw new ConflictException({
          code: "OUT_OF_STOCK",
          message: "Items are no longer available — please update your cart",
        });
      } finally {
        await session.endSession();
      }
    }

    const newReference = this.generateReference(order.orderNumber);
    const newExpiresAt = new Date(Date.now() + this.holdMinutes * 60 * 1000);

    const updated = await this.orderModel.findByIdAndUpdate(
      order._id,
      {
        reservationExpiresAt: newExpiresAt,
        $push: {
          paymentAttempts: {
            reference: newReference,
            provider: opts.provider,
            status: "INITIATED",
            failureCode: null,
            rawFailureReason: null,
            createdAt: new Date(),
          },
        },
      },
      { new: true },
    );

    this.logger.log({
      event: "retry_payment_prepared",
      orderNumber: order.orderNumber,
      holdExpired,
      newExpiresAt,
    });

    return { order: updated!, newReference };
  }

  /**
   * Push the first INITIATED attempt after initializePayment succeeds.
   * Called by PaymentController/PaymentService once a checkoutUrl is available.
   */
  async recordInitiatedAttempt(opts: {
    orderId: string;
    reference: string;
    provider: "paystack" | "flutterwave";
  }): Promise<void> {
    await this.orderModel.findByIdAndUpdate(opts.orderId, {
      $push: {
        paymentAttempts: {
          reference: opts.reference,
          provider: opts.provider,
          status: "INITIATED",
          failureCode: null,
          rawFailureReason: null,
          createdAt: new Date(),
        },
      },
    });
  }

  // ─── Sent-emails idempotency ──────────────────────────────────────────────

  /**
   * Marks an email type as sent for the given order.
   * Returns true if this was the FIRST time (i.e. the email should be sent now).
   * Returns false if already sent (caller should skip).
   */
  async markEmailSent(orderId: string, emailType: string): Promise<boolean> {
    const result = await this.orderModel.findOneAndUpdate(
      {
        _id: orderId,
        [`sentEmails.${emailType}`]: { $exists: false },
      },
      { $set: { [`sentEmails.${emailType}`]: new Date() } },
      { new: false }, // return old doc — if null, it was already set
    );
    return result !== null; // true = first time
  }

  // ─── POD: confirm delivery payment ────────────────────────────────────────

  async confirmDeliveryPayment(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId);
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "awaiting_delivery_payment") {
      throw new BadRequestException(
        `Order is not awaiting delivery payment — current status: ${order.status}`,
      );
    }

    for (const item of order.items) {
      await this.inventoryService.commitReservedStock(item.productId, item.qty);
    }

    const now = new Date();
    order.status = "fulfilled";
    order.paidAt = now;
    order.fulfilledAt = now;
    this.logger.log({ event: "pod_delivery_confirmed", orderNumber: order.orderNumber });
    return order.save();
  }

  // ─── BNPL ─────────────────────────────────────────────────────────────────

  async markInInstallments(orderId: string): Promise<OrderDocument> {
    const order = await this.orderModel.findOneAndUpdate(
      { _id: orderId, status: "pending_payment" },
      { status: "in_installments" },
      { new: true },
    );
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async markCancelledByInstallmentPlan(orderId: string): Promise<void> {
    await this.orderModel.findByIdAndUpdate(orderId, { status: "cancelled" });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async findByReference(ref: string): Promise<OrderDocument | null> {
    return this.orderModel.findOne({ paymentReference: ref });
  }

  /**
   * Find by either the order's primary paymentReference OR any
   * paymentAttempts[].reference (for retry flow).
   */
  async findByAnyReference(ref: string): Promise<OrderDocument | null> {
    return this.orderModel.findOne({
      $or: [{ paymentReference: ref }, { "paymentAttempts.reference": ref }],
    });
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderDocument> {
    const order = await this.orderModel.findOne({ orderNumber });
    if (!order) throw new NotFoundException("Order not found");
    return order;
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

  async findAll(
    pagination: PaginationDto,
    status?: OrderStatus,
    extraFilter: Record<string, unknown> = {},
  ) {
    const filter: Record<string, unknown> = status ? { status } : {};
    Object.assign(filter, extraFilter);
    // If status was set via extraFilter but not the param, it's already in filter
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

  /**
   * Orders whose reservationExpiresAt has passed and are still pending_payment.
   * Used by the expiry processor instead of a fixed-age query.
   */
  async findExpiredReservations(): Promise<OrderDocument[]> {
    return this.orderModel.find({
      status: "pending_payment",
      reservationExpiresAt: { $lt: new Date() },
    });
  }

  async findStalePodOrders(olderThanDays: number): Promise<OrderDocument[]> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    return this.orderModel.find({
      status: "awaiting_delivery_payment",
      createdAt: { $lt: cutoff },
    });
  }

  /** @deprecated Use findExpiredReservations() instead */
  async findStalePendingOrders(olderThanMinutes: number): Promise<OrderDocument[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return this.orderModel.find({
      status: "pending_payment",
      createdAt: { $lt: cutoff },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  readonly withId = <T extends { _id: unknown }>(doc: T): T & { id: string } => ({
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
}
