import {
  BadRequestException,
  Body,
  Controller,
  forwardRef,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, IsNotEmpty } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrderService } from "./order.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentService } from "../payment/payment.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ORDER_STATUS_ENUM, OrderStatus } from "./schemas/order.schema";
import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import { PaginationDto } from "../../common/dto/pagination.dto";
import {
  ApiEnvelopeOk,
  ApiEnvelopeCreated,
  ApiPaginatedOk,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";
import { OrderResponseDto } from "../../common/swagger/swagger-response.dto";

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class AdminOrderQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ORDER_STATUS_ENUM)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(["true", "false"])
  refundRequired?: string;

  @IsOptional()
  @IsEnum(["true", "false"])
  cancellationRequested?: string;

  @IsOptional()
  @IsEnum(["true", "false"])
  needsAmountReview?: string;
}

class RetryPaymentDto {
  @ApiProperty({ enum: ["paystack", "flutterwave"] })
  @IsEnum(["paystack", "flutterwave"])
  provider: "paystack" | "flutterwave";

  @ApiPropertyOptional({ description: "Guest access token (omit when authenticated)" })
  @IsOptional()
  @IsString()
  token?: string;
}

class CancelOrderDto {
  @ApiPropertyOptional({ description: "Guest access token (omit when authenticated)" })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ example: "Changed my mind" })
  @IsOptional()
  @IsString()
  reason?: string;
}

class TrackOrderDto {
  @ApiProperty({ example: "AV-2601" })
  @IsString()
  @IsNotEmpty()
  orderNumber: string;

  @ApiProperty({ description: "Email OR phone on the order" })
  @IsString()
  @IsNotEmpty()
  emailOrPhone: string;
}

// ─── Customer-facing ──────────────────────────────────────────────────────────

@ApiTags("Orders")
@Controller({ path: "orders", version: "1" })
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly notifications: NotificationsService,
    // forwardRef breaks the OrderModule ↔ PaymentModule circular dep
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
  ) {}

  // ── Create order ──────────────────────────────────────────────────────────

  @UseGuards(OptionalJwtAuthGuard)
  @Post()
  @ApiOperation({
    summary: "Create order",
    description:
      "Creates an order and reserves stock atomically. " +
      "Guest users MUST supply customerEmail. " +
      "Installment (Pay Small Small) requires a registered account. " +
      "Returns the raw accessToken for guest orders — store it, it is never shown again.",
  })
  @ApiEnvelopeCreated(OrderResponseDto)
  @ApiBadRequestResponse({
    description: "Cart is empty / validation error",
    type: ApiErrorResponse,
  })
  async createOrder(
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: JwtPayload | undefined,
    @Req() req: Request,
  ) {
    if (user) dto._isAuthenticated = true;

    if (!dto.guestId && !dto.cartId) {
      const guestId = req.headers["x-guest-id"] as string | undefined;
      if (guestId) dto.guestId = guestId;
    }

    const order = await this.orderService.createOrder(dto, user?.sub ?? null);
    const orderId = (order._id as { toString(): string }).toString();
    const rawToken = order.customerId
      ? undefined
      : await this.orderService.issueAccessToken(orderId);

    return { order, ...(rawToken !== undefined ? { accessToken: rawToken } : {}) };
  }

  // ── Authenticated customer routes ─────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("mine")
  @ApiOperation({ summary: "Get order history for the current customer" })
  @ApiPaginatedOk(OrderResponseDto)
  myOrders(@CurrentUser() user: JwtPayload, @Query() pagination: PaginationDto) {
    return this.orderService.findByCustomer(user.sub, pagination);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  @ApiOperation({ summary: "Get a single order by id (authenticated)" })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  @ApiNotFoundResponse({ description: "Order not found", type: ApiErrorResponse })
  getOrder(@Param("id") id: string) {
    return this.orderService.findById(id);
  }

  // ── Public order view (token-gated, no auth required) ────────────────────

  @Get("public/:orderNumber")
  @ApiOperation({
    summary: "Public order view",
    description:
      "Returns a minimal public-safe snapshot. " +
      "Requires a valid ?token= query param. " +
      "Same 404 for wrong token and missing order — prevents enumeration.",
  })
  @ApiParam({ name: "orderNumber", example: "AV-2601" })
  @ApiQuery({ name: "token", required: true })
  @ApiNotFoundResponse({ description: "Order not found or token invalid", type: ApiErrorResponse })
  async getPublicOrder(
    @Param("orderNumber") orderNumber: string,
    @Query("token") rawToken: string,
  ) {
    if (!rawToken) throw new NotFoundException("Order not found");

    const order = await this.orderService.findByOrderNumber(orderNumber).catch(() => null);
    if (!order) throw new NotFoundException("Order not found");

    const valid = await this.orderService.verifyAccessToken(order, rawToken);
    if (!valid) throw new NotFoundException("Order not found");

    const latestFailed = [...(order.paymentAttempts ?? [])]
      .reverse()
      .find((a) => a.status === "FAILED");

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      items: order.items.map((i) => ({
        title: i.title,
        image: i.image,
        qty: i.qty,
        unitPrice: i.unitPrice,
      })),
      subtotal: order.subtotal,
      total: order.total,
      paymentProvider: order.paymentProvider,
      paymentMethod: order.paymentMethod,
      reservationExpiresAt: order.reservationExpiresAt,
      deliveryArea: order.shippingAddress
        ? `${order.shippingAddress.city}, ${order.shippingAddress.state}`
        : null,
      maskedPhone: order.shippingAddress?.phone
        ? `****${order.shippingAddress.phone.slice(-4)}`
        : null,
      failureCode: latestFailed?.failureCode ?? null,
    };
  }

  // ── Track order ───────────────────────────────────────────────────────────

  @Post("track")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: "Request order tracking link",
    description:
      "Always returns the same generic response. On a match, emails a fresh secure link. " +
      "Rate limited: 5 req/min per IP.",
  })
  async trackOrder(@Body() dto: TrackOrderDto) {
    const GENERIC = {
      message: "If we found your order, a link has been sent to the email on file.",
    };

    try {
      const order = await this.orderService.findByOrderNumber(dto.orderNumber).catch(() => null);
      if (order) {
        const input = dto.emailOrPhone.trim().toLowerCase();
        const orderEmail = (order.customerEmail ?? "").toLowerCase();
        const orderPhone = (order.shippingAddress?.phone ?? "").replace(/\s/g, "").toLowerCase();
        const matches =
          (orderEmail && input === orderEmail) || (orderPhone && input === orderPhone);

        if (matches && order.customerEmail) {
          const orderId = (order._id as { toString(): string }).toString();
          const rawToken = await this.orderService.issueAccessToken(orderId);
          await this.notifications.sendTrackLink({
            to: order.customerEmail,
            orderNumber: order.orderNumber,
            rawToken,
            customerName: order.customerName,
          });
        }
      }
    } catch {
      // Always return generic — never leak error details
    }

    return GENERIC;
  }

  // ── Retry payment ─────────────────────────────────────────────────────────

  @UseGuards(OptionalJwtAuthGuard)
  @Post(":orderNumber/retry-payment")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Retry payment for a pending order",
    description:
      "Creates a new payment attempt. If the hold window expired, re-reserves stock " +
      "(409 OUT_OF_STOCK if unavailable). Guest users must supply token.",
  })
  @ApiParam({ name: "orderNumber", example: "AV-2601" })
  @ApiBadRequestResponse({
    description: "Invalid status or stock unavailable",
    type: ApiErrorResponse,
  })
  async retryPayment(
    @Param("orderNumber") orderNumber: string,
    @Body() dto: RetryPaymentDto,
    @CurrentUser() user: JwtPayload | undefined,
  ) {
    const { order, newReference } = await this.orderService.prepareRetryPayment({
      orderNumber,
      provider: dto.provider,
      rawToken: dto.token,
      userId: user?.sub,
    });

    // Patch the reference on the document object for initializePayment
    // (the DB record is already updated by prepareRetryPayment)
    order.paymentReference = newReference;
    order.paymentProvider = dto.provider;

    const result = await this.paymentService.initializePayment(order);
    if (!result) throw new BadRequestException("Could not initialize payment");

    return { checkoutUrl: result.checkoutUrl, reference: result.reference };
  }

  // ── Cancel order ──────────────────────────────────────────────────────────

  @UseGuards(OptionalJwtAuthGuard)
  @Post(":orderNumber/cancel")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Cancel or request cancellation of an order",
    description:
      "pending_payment / awaiting_delivery_payment → cancels immediately. " +
      "paid → queues for admin review (202). Other statuses → 409.",
  })
  @ApiParam({ name: "orderNumber", example: "AV-2601" })
  async cancelOrder(
    @Param("orderNumber") orderNumber: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: JwtPayload | undefined,
  ) {
    const result = await this.orderService.requestCancellation({
      orderNumber,
      reason: dto.reason,
      rawToken: dto.token,
      userId: user?.sub,
    });

    const order = await this.orderService.findByOrderNumber(orderNumber);
    const orderId = (order._id as { toString(): string }).toString();
    const rawToken =
      dto.token ??
      (order.customerId ? undefined : await this.orderService.issueAccessToken(orderId));
    await this.notifications.sendOrderCancelled(order, rawToken);

    return result;
  }
}

// ─── Admin-facing ─────────────────────────────────────────────────────────────

@ApiTags("Admin — Orders")
@ApiBearerAuth()
@Controller({ path: "admin/orders", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "support_agent")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AdminOrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  @ApiOperation({
    summary: "[Admin] List all orders",
    description:
      "Filter by status (including refund_required), refundRequired=true, " +
      "cancellationRequested=true, needsAmountReview=true.",
  })
  @ApiPaginatedOk(OrderResponseDto)
  listOrders(@Query() query: AdminOrderQueryDto) {
    const extraFilter: Record<string, unknown> = {};
    if (query.refundRequired === "true") extraFilter["status"] = "refund_required";
    if (query.cancellationRequested === "true") {
      extraFilter["cancellationRequestedAt"] = { $ne: null };
    }
    if (query.needsAmountReview === "true") extraFilter["needsAmountReview"] = true;

    const statusFilter: OrderStatus | undefined =
      (extraFilter["status"] as OrderStatus | undefined) ?? query.status;
    return this.orderService.findAll(query, statusFilter, extraFilter);
  }

  @Get(":id")
  @ApiOperation({ summary: "[Admin] Get a single order with paymentAttempts, cancellation data" })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  @ApiNotFoundResponse({ description: "Order not found", type: ApiErrorResponse })
  getOrder(@Param("id") id: string) {
    return this.orderService.findById(id);
  }

  @Patch(":id/fulfil")
  @Roles("super_admin")
  fulfil(@Param("id") id: string) {
    return this.orderService.markFulfilled(id);
  }

  @Patch(":id/cancel")
  @Roles("super_admin")
  cancel(@Param("id") id: string) {
    return this.orderService.markCancelled(id);
  }

  @Patch(":id/confirm-delivery-payment")
  confirmDeliveryPayment(@Param("id") id: string) {
    return this.orderService.confirmDeliveryPayment(id);
  }
}
