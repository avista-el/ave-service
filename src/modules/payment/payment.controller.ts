import {
  BadRequestException,
  Body,
  Controller,
  Headers,
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
  @ApiProperty({
    example: "64a1f2c8e3b7a900120d2222",
    description: "Order ObjectId from POST /v1/orders",
  })
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiProperty({ enum: ["paystack", "flutterwave"], example: "paystack" })
  @IsEnum(["paystack", "flutterwave"])
  provider: "paystack" | "flutterwave";
}

@ApiTags("Payments")
@Controller({ path: "payments", version: "1" })
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly orderService: OrderService,
  ) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Post("initialize")
  @ApiOperation({
    summary: "Get hosted checkout URL",
    description: `Call this after \`POST /v1/orders\`. Returns the provider's hosted checkout URL to redirect the customer to. Payment confirmation comes via webhook — never via the redirect.`,
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
    if (dto.provider === "paystack") return this.paymentService.initializePaystack(order);
    return this.paymentService.initializeFlutterwave(order);
  }

  @Post("webhooks/paystack")
  @ApiOperation({
    summary: "Paystack webhook receiver",
    description:
      "Internal endpoint — called by Paystack only. Verifies the HMAC-SHA512 signature, then updates order status and commits reserved stock. Idempotent: duplicate events are safely ignored.",
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

  @Post("webhooks/flutterwave")
  @ApiOperation({
    summary: "Flutterwave webhook receiver",
    description:
      "Internal endpoint — called by Flutterwave only. Verifies the signature header, then updates order status and commits stock.",
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
