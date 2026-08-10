import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
  ApiParam,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from "@nestjs/swagger";
import { Request } from "express";
import { CartService } from "./cart.service";
import { AddToCartDto, MergeCartDto, UpdateLineDto } from "./dto/cart.dto";
import { JwtAuthGuard, OptionalJwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import { CartResponseDto } from "../../common/swagger/swagger-response.dto";

function resolveGuest(req: Request): string | null {
  return (req.headers["x-guest-id"] as string) ?? null;
}

@ApiTags("Cart")
@ApiHeader({
  name: "X-Guest-Id",
  required: false,
  description:
    "UUID identifying the guest session. Required for unauthenticated cart operations. Generate client-side with `crypto.randomUUID()` and persist in localStorage.",
  example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
})
@Controller({ path: "cart", version: "1" })
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  @ApiOperation({
    summary: "Get current cart",
    description:
      "Works for both guests (identified by X-Guest-Id header) and authenticated users. Creates an empty cart if none exists.",
  })
  @ApiEnvelopeOk(CartResponseDto)
  getCart(@CurrentUser() user: JwtPayload | undefined, @Req() req: Request) {
    return this.cartService.getCart(user?.sub ?? null, resolveGuest(req));
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post("lines")
  @ApiOperation({
    summary: "Add a product to cart",
    description:
      "If the product already exists in the cart, quantity is incremented. Validates available stock before adding.",
  })
  @ApiEnvelopeOk(CartResponseDto)
  @ApiBadRequestResponse({
    description: "Product out of stock or not available",
    type: ApiErrorResponse,
  })
  addLine(
    @Body() dto: AddToCartDto,
    @CurrentUser() user: JwtPayload | undefined,
    @Req() req: Request,
  ) {
    return this.cartService.addToCart(user?.sub ?? null, resolveGuest(req), dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Patch("lines")
  @ApiOperation({
    summary: "Update line quantity",
    description: "Set `quantity: 0` to remove the line entirely.",
  })
  @ApiEnvelopeOk(CartResponseDto)
  @ApiNotFoundResponse({ description: "Line item not found in cart", type: ApiErrorResponse })
  updateLine(
    @Body() dto: UpdateLineDto,
    @CurrentUser() user: JwtPayload | undefined,
    @Req() req: Request,
  ) {
    return this.cartService.updateLine(user?.sub ?? null, resolveGuest(req), dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Delete("lines/:productId")
  @ApiOperation({ summary: "Remove a specific line from cart" })
  @ApiParam({ name: "productId", description: "Product ObjectId" })
  @ApiEnvelopeOk(CartResponseDto)
  removeLine(
    @Param("productId") productId: string,
    @CurrentUser() user: JwtPayload | undefined,
    @Req() req: Request,
  ) {
    return this.cartService.removeLine(user?.sub ?? null, resolveGuest(req), productId);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Delete()
  @ApiOperation({ summary: "Empty the cart" })
  @ApiEnvelopeOk(CartResponseDto)
  clearCart(@CurrentUser() user: JwtPayload | undefined, @Req() req: Request) {
    return this.cartService.clearCart(user?.sub ?? null, resolveGuest(req));
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post("merge")
  @ApiOperation({
    summary: "Merge guest cart into user cart on login",
    description:
      "Call this immediately after a successful login if the user had items in their guest cart. Guest cart is deleted after merge.",
  })
  @ApiEnvelopeOk(CartResponseDto)
  mergeCart(@Body() dto: MergeCartDto, @CurrentUser() user: JwtPayload) {
    return this.cartService.mergeGuestCart(user.sub, dto.guestId);
  }
}
