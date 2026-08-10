import { Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation, ApiForbiddenResponse } from "@nestjs/swagger";
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SearchService } from "./search.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import { SearchResultDto, SuggestItemDto } from "../../common/swagger/swagger-response.dto";

class SearchQueryDto {
  @ApiPropertyOptional({ example: "hisense 55 tv" }) @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional({ example: "tvs" }) @IsOptional() @IsString() categorySlug?: string;
  @ApiPropertyOptional({ example: "50-59-inch" })
  @IsOptional()
  @IsString()
  subcategorySlug?: string;
  @ApiPropertyOptional({ example: "hisense,lg" }) @IsOptional() @IsString() brands?: string;
  @ApiPropertyOptional({ example: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min?: number;
  @ApiPropertyOptional({ example: 2000000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  max?: number;
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) => value === "true")
  @IsBoolean()
  inStock?: boolean;
  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rating?: number;
  @ApiPropertyOptional({
    example: "price_asc",
    enum: ["featured", "price_asc", "price_desc", "newest", "best_selling", "rating"],
  })
  @IsOptional()
  @IsString()
  sort?: string;
  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;
  @ApiPropertyOptional({ example: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

@ApiTags("Search")
@Controller({ path: "search", version: "1" })
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: "Full-text + faceted product search (Meilisearch)",
    description:
      "Powers the /search results page and category pages. Falls back silently to an empty result set if Meilisearch is unavailable.",
  })
  @ApiEnvelopeOk(SearchResultDto)
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search(query);
  }

  @Get("suggest")
  @ApiOperation({
    summary: "Autosuggest — header search dropdown",
    description:
      "Returns up to 8 matching product names for the given prefix. Used by the header search bar autocomplete.",
  })
  @ApiEnvelopeOk(SuggestItemDto, true)
  suggest(@Query("q") q: string) {
    return this.searchService.suggest(q ?? "");
  }
}

@ApiTags("Admin — Search")
@ApiBearerAuth()
@Controller({ path: "admin/search", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AdminSearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post("reindex")
  @ApiOperation({
    summary: "[Admin] Rebuild the full Meilisearch index from MongoDB",
    description:
      "Enqueues all active products into the Meilisearch `products` index. Use after a bulk import, migration, or if the index becomes stale. This is a background operation — it returns immediately.",
  })
  reindex() {
    return this.searchService.reindexAll();
  }
}
