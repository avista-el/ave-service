import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiConflictResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { CatalogService } from "./catalog.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { QueryProductsDto } from "./dto/query-products.dto";
import { CreateBrandDto } from "./dto/create-brand.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import { ProductTag } from "./schemas/product.schema";
import {
  ApiEnvelopeOk,
  ApiEnvelopeCreated,
  ApiPaginatedOk,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";
import {
  ProductResponseDto,
  BrandDto,
  CategoryDto,
} from "../../common/swagger/swagger-response.dto";

// ─── Storefront (public) ──────────────────────────────────────────────────────

@ApiTags("Catalog — Storefront")
@Controller({ path: "catalog", version: "1" })
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get("products")
  @ApiOperation({
    summary: "List products with filters",
    description:
      "Powers /shop, /shop/:category, and /shop/:category/:subcategory pages. Supports faceted filtering, sorting and pagination. Only active products are returned.",
  })
  @ApiPaginatedOk(ProductResponseDto)
  async listProducts(@Query() query: QueryProductsDto) {
    const result = await this.catalogService.findAllProducts(query);
    return {
      ...result,
      items: result.items.map((p) => this.catalogService.toProductResponse(p)),
    };
  }

  @Get("products/:slug")
  @ApiOperation({
    summary: "Get product by slug",
    description:
      "Returns the full product detail including specs, gallery, and a list of similar products in the same category.",
  })
  @ApiParam({ name: "slug", example: "hisense-55-4k-uhd-smart-tv-a6k" })
  @ApiEnvelopeOk(ProductResponseDto)
  @ApiNotFoundResponse({ description: "Product not found", type: ApiErrorResponse })
  async getProduct(@Param("slug") slug: string) {
    const product = await this.catalogService.findProductBySlug(slug);
    const similar = await this.catalogService.getSimilarProducts(
      (product._id as unknown as { toString(): string }).toString(),
    );
    return {
      product: this.catalogService.toProductResponse(product),
      similar: similar.map((p) => this.catalogService.toProductResponse(p)),
    };
  }

  @Get("categories")
  @ApiOperation({
    summary: "List all top-level categories with subcategories",
    description: "Returns the full category tree. Used by the mega-menu and shop-by-category grid.",
  })
  @ApiEnvelopeOk(CategoryDto, true)
  listCategories() {
    return this.catalogService.findAllCategories();
  }

  @Get("categories/:slug")
  @ApiOperation({ summary: "Get category by slug" })
  @ApiParam({ name: "slug", example: "tvs" })
  @ApiEnvelopeOk(CategoryDto)
  @ApiNotFoundResponse({ description: "Category not found", type: ApiErrorResponse })
  getCategory(@Param("slug") slug: string) {
    return this.catalogService.findCategoryBySlug(slug);
  }

  @Get("brands")
  @ApiOperation({
    summary: "List all brands",
    description:
      "Returns all brands sorted alphabetically. Used by the shop-by-brand strip and filter sidebar.",
  })
  @ApiEnvelopeOk(BrandDto, true)
  listBrands() {
    return this.catalogService.findAllBrands();
  }
}

// ─── Admin (protected) ────────────────────────────────────────────────────────

@ApiTags("Admin — Catalog")
@ApiBearerAuth()
@Controller({ path: "admin/catalog", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AdminCatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // ── Products ──────────────────────────────────────────────────────────────

  @Get("products")
  @ApiOperation({
    summary: "[Admin] List all products (all statuses)",
    description:
      "Returns draft and archived products in addition to active ones. Supports the same filter/sort/pagination params as the storefront.",
  })
  @ApiPaginatedOk(ProductResponseDto)
  async listProducts(@Query() query: QueryProductsDto) {
    const result = await this.catalogService.findAllProducts(query, true);
    return {
      ...result,
      items: result.items.map((p) => this.catalogService.toProductResponse(p)),
    };
  }

  @Post("products")
  @ApiOperation({
    summary: "[Admin] Create a new product",
    description:
      "Creates a product with status `draft` by default. Upload images to Cloudinary first via `GET /v1/admin/media/sign`, then pass the returned URLs here.",
  })
  @ApiEnvelopeCreated(ProductResponseDto)
  @ApiConflictResponse({ description: "SKU already exists", type: ApiErrorResponse })
  @ApiBadRequestResponse({ description: "Validation error", type: ApiErrorResponse })
  async createProduct(@Body() dto: CreateProductDto, @CurrentUser() user: JwtPayload) {
    const product = await this.catalogService.createProduct(dto, user.sub);
    return this.catalogService.toProductResponse(product);
  }

  @Patch("products/:id")
  @ApiOperation({ summary: "[Admin] Update a product" })
  @ApiParam({ name: "id", description: "Product ObjectId" })
  @ApiEnvelopeOk(ProductResponseDto)
  @ApiNotFoundResponse({ description: "Product not found", type: ApiErrorResponse })
  async updateProduct(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const product = await this.catalogService.updateProduct(id, dto, user.sub);
    return this.catalogService.toProductResponse(product);
  }

  @Delete("products/:id")
  @ApiOperation({
    summary: "[Admin] Archive a product",
    description:
      "Sets status to `archived`. Does not permanently delete. The product is hidden from the storefront.",
  })
  @ApiParam({ name: "id", description: "Product ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Product not found", type: ApiErrorResponse })
  async deleteProduct(@Param("id") id: string) {
    await this.catalogService.deleteProduct(id);
    return { message: "Product archived" };
  }

  @Patch("products/:id/tags/:tag")
  @ApiOperation({
    summary: "[Admin] Toggle a merchandising tag",
    description:
      "Toggles one of `new_arrival | best_seller | featured | deal` on a product. Idempotent — calling it twice returns to the original state.",
  })
  @ApiParam({ name: "id", description: "Product ObjectId" })
  @ApiParam({ name: "tag", enum: ["new_arrival", "best_seller", "featured", "deal"] })
  @ApiEnvelopeOk(ProductResponseDto)
  async toggleTag(
    @Param("id") id: string,
    @Param("tag") tag: ProductTag,
    @CurrentUser() user: JwtPayload,
  ) {
    const product = await this.catalogService.toggleTag(id, tag, user.sub);
    return this.catalogService.toProductResponse(product);
  }

  // ── Brands ────────────────────────────────────────────────────────────────

  @Get("brands")
  @ApiOperation({ summary: "[Admin] List all brands" })
  @ApiEnvelopeOk(BrandDto, true)
  listBrands() {
    return this.catalogService.findAllBrands();
  }

  @Post("brands")
  @ApiOperation({ summary: "[Admin] Create a brand" })
  @ApiEnvelopeCreated(BrandDto)
  @ApiConflictResponse({ description: "Brand slug already exists", type: ApiErrorResponse })
  createBrand(@Body() dto: CreateBrandDto) {
    return this.catalogService.createBrand(dto);
  }

  @Patch("brands/:id")
  @ApiOperation({ summary: "[Admin] Update a brand" })
  @ApiParam({ name: "id", description: "Brand ObjectId" })
  @ApiEnvelopeOk(BrandDto)
  updateBrand(@Param("id") id: string, @Body() dto: Partial<CreateBrandDto>) {
    return this.catalogService.updateBrand(id, dto);
  }

  @Delete("brands/:id")
  @ApiOperation({ summary: "[Admin] Delete a brand" })
  @ApiParam({ name: "id", description: "Brand ObjectId" })
  @ApiEnvelopeOk(Object)
  async deleteBrand(@Param("id") id: string) {
    await this.catalogService.deleteBrand(id);
    return { message: "Brand deleted" };
  }

  // ── Categories ────────────────────────────────────────────────────────────

  @Get("categories")
  @ApiOperation({ summary: "[Admin] List all categories" })
  @ApiEnvelopeOk(CategoryDto, true)
  listCategories() {
    return this.catalogService.findAllCategories();
  }

  @Post("categories")
  @ApiOperation({ summary: "[Admin] Create a category" })
  @ApiEnvelopeCreated(CategoryDto)
  @ApiConflictResponse({ description: "Category slug already exists", type: ApiErrorResponse })
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.catalogService.createCategory(dto);
  }

  @Patch("categories/:id")
  @ApiOperation({ summary: "[Admin] Update a category" })
  @ApiParam({ name: "id", description: "Category ObjectId" })
  @ApiEnvelopeOk(CategoryDto)
  updateCategory(@Param("id") id: string, @Body() dto: Partial<CreateCategoryDto>) {
    return this.catalogService.updateCategory(id, dto);
  }

  @Delete("categories/:id")
  @ApiOperation({ summary: "[Admin] Delete a category" })
  @ApiParam({ name: "id", description: "Category ObjectId" })
  @ApiEnvelopeOk(Object)
  async deleteCategory(@Param("id") id: string) {
    await this.catalogService.deleteCategory(id);
    return { message: "Category deleted" };
  }
}
