import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PromotionsService } from "./promotions.service";
import { CreateDiscountDto } from "./dto/create-discount.dto";
import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  ApiEnvelopeOk,
  ApiEnvelopeCreated,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";
import { PromoValidateResponseDto } from "../../common/swagger/swagger-response.dto";

class ValidatePromoDto {
  @ApiProperty({ example: "COOL20" })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 500000, description: "Cart subtotal in NGN before discount" })
  @IsNumber()
  @Min(0)
  orderTotal: number;

  @ApiPropertyOptional({ example: "air-conditioners" })
  @IsOptional()
  @IsString()
  categorySlug?: string;
}

// ─── Public ───────────────────────────────────────────────────────────────────

@ApiTags("Promotions")
@Controller({ path: "promotions", version: "1" })
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Post("validate")
  @ApiOperation({
    summary: "Validate a promo code",
    description:
      "Used by the cart page before checkout. Returns the computed discount amount in NGN. Does not increment usage — that happens after successful payment.",
  })
  @ApiEnvelopeOk(PromoValidateResponseDto)
  @ApiBadRequestResponse({
    description: "Invalid / expired / limit-reached code",
    type: ApiErrorResponse,
  })
  validatePromo(@Body() dto: ValidatePromoDto) {
    return this.promotionsService.validateAndApply(dto.code, dto.orderTotal, dto.categorySlug);
  }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

@ApiTags("Admin — Promotions")
@ApiBearerAuth()
@Controller({ path: "admin/promotions", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  @ApiOperation({ summary: "[Admin] List all discount codes" })
  @ApiEnvelopeOk(CreateDiscountDto, true)
  findAll() {
    return this.promotionsService.findAll();
  }

  @Post()
  @ApiOperation({ summary: "[Admin] Create a discount code" })
  @ApiEnvelopeCreated(CreateDiscountDto)
  @ApiConflictResponse({ description: "Code already exists", type: ApiErrorResponse })
  create(@Body() dto: CreateDiscountDto) {
    return this.promotionsService.create(dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "[Admin] Update a discount code" })
  @ApiParam({ name: "id", description: "Discount code ObjectId" })
  @ApiEnvelopeOk(CreateDiscountDto)
  update(@Param("id") id: string, @Body() dto: Partial<CreateDiscountDto>) {
    return this.promotionsService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "[Admin] Delete a discount code" })
  @ApiParam({ name: "id", description: "Discount code ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Discount code not found", type: ApiErrorResponse })
  async remove(@Param("id") id: string) {
    await this.promotionsService.remove(id);
    return { message: "Discount code deleted" };
  }
}
