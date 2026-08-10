import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";
import { InventoryService } from "./inventory.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";

class SetStockDto {
  @ApiProperty({ example: "64a1f2c8e3b7a900120d9999", description: "Product ObjectId" })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({
    example: 40,
    description: "Absolute stock value — not a delta. Validated against current reserved quantity.",
  })
  @IsInt()
  @Min(0)
  stock: number;
}

@ApiTags("Admin — Inventory")
@ApiBearerAuth()
@Controller({ path: "admin/inventory", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get("stock/:productId")
  @ApiOperation({ summary: "[Admin] Get stock status for a product" })
  @ApiParam({ name: "productId", description: "Product ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Product not found", type: ApiErrorResponse })
  getStockStatus(@Param("productId") productId: string) {
    return this.inventoryService.getStockStatus(productId);
  }

  @Get("low-stock")
  @ApiOperation({
    summary: "[Admin] List products with low or zero available stock",
    description:
      "Returns products where `stock - reserved <= 5`. Used by the admin dashboard low-stock alert widget.",
  })
  @ApiEnvelopeOk(Object, true)
  getLowStock() {
    return this.inventoryService.getLowStockProducts();
  }

  @Patch("stock")
  @ApiOperation({
    summary: "[Admin] Set absolute stock for a product",
    description:
      "**Absolute value** — sets `stock` to the provided number. Will be rejected if the new value is lower than the current `reserved` quantity (units held by in-flight orders). Always validated before write.",
  })
  @ApiEnvelopeOk(Object)
  @ApiConflictResponse({
    description: "New stock is below reserved quantity",
    type: ApiErrorResponse,
  })
  @ApiNotFoundResponse({ description: "Product not found", type: ApiErrorResponse })
  setStock(@Body() dto: SetStockDto, @CurrentUser() user: JwtPayload) {
    return this.inventoryService.setStock(dto.productId, dto.stock, user.sub);
  }
}
