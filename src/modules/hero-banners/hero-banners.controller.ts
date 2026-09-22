import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { HeroBannersService } from "./hero-banners.service";
import { CreateHeroBannerDto } from "./dto/create-hero-banner.dto";
import { UpdateHeroBannerDto } from "./dto/update-hero-banner.dto";
import { ReorderHeroBannersDto } from "./dto/reorder-hero-banners.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  ApiEnvelopeOk,
  ApiEnvelopeCreated,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";

// ─── Storefront (public) ──────────────────────────────────────────────────────

@ApiTags("Hero Banners — Storefront")
@Controller({ path: "hero-banners", version: "1" })
export class HeroBannersController {
  constructor(private readonly service: HeroBannersService) {}

  @Get()
  @ApiOperation({
    summary: "List active hero banners",
    description: "Returns only active banners ordered by sortOrder. Used by the homepage carousel.",
  })
  @ApiEnvelopeOk(Object, true)
  async listActive() {
    const banners = await this.service.findActive();
    return banners.map((b) => this.service.toResponse(b));
  }
}

// ─── Admin (protected) ────────────────────────────────────────────────────────

@ApiTags("Admin — Hero Banners")
@ApiBearerAuth()
@Controller({ path: "admin/hero-banners", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AdminHeroBannersController {
  constructor(private readonly service: HeroBannersService) {}

  @Get()
  @ApiOperation({ summary: "[Admin] List all banners (active + inactive)" })
  @ApiEnvelopeOk(Object, true)
  async listAll() {
    const banners = await this.service.findAll();
    return banners.map((b) => this.service.toResponse(b));
  }

  @Post()
  @ApiOperation({ summary: "[Admin] Create a hero banner" })
  @ApiEnvelopeCreated(Object)
  async create(@Body() dto: CreateHeroBannerDto) {
    const banner = await this.service.create(dto);
    return this.service.toResponse(banner);
  }

  @Patch("reorder")
  @ApiOperation({
    summary: "[Admin] Reorder banners",
    description: "Pass banner IDs in the desired display order. Updates sortOrder on each.",
  })
  @ApiEnvelopeOk(Object)
  async reorder(@Body() dto: ReorderHeroBannersDto) {
    await this.service.reorder(dto.ids);
    return { message: "Banners reordered." };
  }

  @Patch(":id")
  @ApiOperation({ summary: "[Admin] Update a hero banner" })
  @ApiParam({ name: "id", description: "Banner ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Banner not found", type: ApiErrorResponse })
  async update(@Param("id") id: string, @Body() dto: UpdateHeroBannerDto) {
    const banner = await this.service.update(id, dto);
    return this.service.toResponse(banner);
  }

  @Delete(":id")
  @ApiOperation({ summary: "[Admin] Delete a hero banner" })
  @ApiParam({ name: "id", description: "Banner ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Banner not found", type: ApiErrorResponse })
  async remove(@Param("id") id: string) {
    await this.service.remove(id);
    return { message: "Banner deleted." };
  }
}
