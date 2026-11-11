import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
} from "@nestjs/swagger";
import { Request } from "express";
import { IsEnum, IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { PaymentService } from "./payment.service";
import { OrderService } from "../order/order.service";
import { OptionalJwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import { InitializePaymentResponseDto } from "../../common/swagger/swagger-response.dto";

class InitializePaymentDto {
  @ApiProperty({ example: "64a1f2c8e3b7a900120d2222" })
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiProperty({ enum: ["paystack", "flutterwave"], example: "paystack" })
  @IsEnum(["paystack", "flutterwave"])
  provider: "paystack" | "flutterwave";
}

class VerifyPaymentDto {
  @ApiProperty({
    example: "AV-2601",
    description: "Order number (AV-XXXX format)",
  })
  @IsString()
  @IsNotEmpty()
  orderNumber: string;

  @ApiProperty({
    example: "AV-2601-M5X3K",
    description:
      "Payment reference — the specific attempt reference to verify. " +
      "Runs the same success/failure handler as the inbound webhook. Safe to call multiple times.",
  })
  @IsString()
  @IsNotEmpty()
  reference: string;
}

@ApiTags("Payments")
@Controller({ path: "payments", version: "1" })
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly orderService: OrderService,
  ) {}

  // ── Initialize ────────────────────────────────────────────────────────────

  @UseGuards(OptionalJwtAuthGuard)
  @Post("initialize")
  @ApiOperation({
    summary: "Get hosted checkout URL",
    description:
      "Call after POST /v1/orders for gateway orders. " +
      "Available to both authenticated users and guests. " +
      "Records an INITIATED payment attempt on the order.",
  })
  @ApiEnvelopeOk(InitializePaymentResponseDto)
  @ApiBadRequestResponse({
    description: "Order not found or provider error",
    type: ApiErrorResponse,
  })
  async initialize(
    @Body() dto: InitializePaymentDto,
    @CurrentUser() _user: JwtPayload | undefined,
  ) {
    const order = await this.orderService.findById(dto.orderId);
    const result = await this.paymentService.initializePayment(order);
    if (!result) {
      throw new BadRequestException("This order does not require a payment gateway redirect");
    }
    return result;
  }

  // ── Verify ────────────────────────────────────────────────────────────────

  @UseGuards(OptionalJwtAuthGuard)
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify a payment and process its outcome",
    description:
      "Calls the gateway's verify API for the given reference, then runs the same " +
      "success/failure handler as the inbound webhook. " +
      "Uses WebhookEvent dedup so it is safe to call multiple times. " +
      "The confirmation page uses this so order status never depends solely on a webhook arriving.",
  })
  @ApiBadRequestResponse({ description: "Reference not found", type: ApiErrorResponse })
  async verify(@Body() dto: VerifyPaymentDto) {
    const { status, order } = await this.paymentService.verifyAndProcess(dto.reference);
    return {
      reference: dto.reference,
      gatewayStatus: status,
      orderStatus: order?.status ?? null,
      orderNumber: order?.orderNumber ?? dto.orderNumber,
    };
  }

  // ── Paystack webhook ──────────────────────────────────────────────────────

  @Post("webhooks/paystack")
  @ApiOperation({
    summary: "Paystack webhook receiver",
    description:
      "Internal endpoint. Verifies HMAC-SHA512 signature. " +
      "Failure events no longer release stock — the reservation stays alive until reservationExpiresAt.",
  })
  @ApiUnauthorizedResponse({ description: "Invalid webhook signature", type: ApiErrorResponse })
  async paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-paystack-signature") signature: string,
  ) {
    const raw = req.rawBody;
    if (!raw) throw new BadRequestException("Missing raw body");
    await this.paymentService.handlePaystackWebhook(raw, signature);
    return { received: true };
  }

  // ── Flutterwave webhook ───────────────────────────────────────────────────

  @Post("webhooks/flutterwave")
  @ApiOperation({
    summary: "Flutterwave webhook receiver",
    description: "Internal endpoint. Verifies signature header.",
  })
  @ApiUnauthorizedResponse({ description: "Invalid webhook signature", type: ApiErrorResponse })
  async flutterwaveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("verif-hash") signature: string,
  ) {
    const raw = req.rawBody;
    if (!raw) throw new BadRequestException("Missing raw body");
    await this.paymentService.handleFlutterwaveWebhook(raw, signature);
    return { received: true };
  }
}
