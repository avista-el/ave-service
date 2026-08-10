import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { IsEnum, IsOptional } from "class-validator";
import { OrderService } from "./order.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrderStatus } from "./schemas/order.schema";
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

class AdminOrderQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(["pending_payment", "paid", "failed", "abandoned", "fulfilled", "cancelled", "refunded"])
  status?: OrderStatus;
}

// ─── Customer-facing ──────────────────────────────────────────────────────────

@ApiTags("Orders")
@Controller({ path: "orders", version: "1" })
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Post()
  @ApiOperation({
    summary: "Create order and get checkout URL",
    description: `Creates a \`pending_payment\` order, atomically reserves stock for all line items (using a Mongo transaction), then returns the hosted payment URL from Paystack or Flutterwave. The frontend should redirect the customer to \`checkoutUrl\`. **Never trust a client-side redirect as payment confirmation** — wait for the webhook or poll \`GET /v1/orders/:id\`.`,
  })
  @ApiEnvelopeCreated(OrderResponseDto)
  @ApiBadRequestResponse({
    description: "Cart is empty / validation error",
    type: ApiErrorResponse,
  })
  createOrder(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtPayload | undefined) {
    return this.orderService.createOrder(dto, user?.sub ?? null);
  }

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
  @ApiOperation({ summary: "Get a single order by id" })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  @ApiNotFoundResponse({ description: "Order not found", type: ApiErrorResponse })
  getOrder(@Param("id") id: string) {
    return this.orderService.findById(id);
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
    description: "Supports optional `status` filter. Returns newest first.",
  })
  @ApiPaginatedOk(OrderResponseDto)
  listOrders(@Query() query: AdminOrderQueryDto) {
    return this.orderService.findAll(query, query.status);
  }

  @Get(":id")
  @ApiOperation({ summary: "[Admin] Get a single order" })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  @ApiNotFoundResponse({ description: "Order not found", type: ApiErrorResponse })
  getOrder(@Param("id") id: string) {
    return this.orderService.findById(id);
  }

  @Patch(":id/fulfil")
  @Roles("super_admin")
  @ApiOperation({ summary: "[Admin] Mark order as fulfilled" })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  fulfil(@Param("id") id: string) {
    return this.orderService.markFulfilled(id);
  }

  @Patch(":id/cancel")
  @Roles("super_admin")
  @ApiOperation({
    summary: "[Admin] Cancel an order",
    description:
      "Releases reserved stock. Cannot cancel a paid or fulfilled order — issue a refund instead.",
  })
  @ApiParam({ name: "id", description: "Order ObjectId" })
  @ApiEnvelopeOk(OrderResponseDto)
  @ApiBadRequestResponse({
    description: "Cannot cancel paid/fulfilled order",
    type: ApiErrorResponse,
  })
  cancel(@Param("id") id: string) {
    return this.orderService.markCancelled(id);
  }
}
