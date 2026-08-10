import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { PaginationDto } from "../../../common/dto/pagination.dto";
import { ProductTag, ProductStatus } from "../schemas/product.schema";

export type SortKey =
  "featured" | "price_asc" | "price_desc" | "newest" | "best_selling" | "rating";

export class QueryProductsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Full-text search query" })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ example: "tvs" })
  @IsOptional()
  @IsString()
  categorySlug?: string;

  @ApiPropertyOptional({ example: "50-59-inch" })
  @IsOptional()
  @IsString()
  subcategorySlug?: string;

  @ApiPropertyOptional({ example: "hisense,lg", description: "Comma-separated brand slugs" })
  @IsOptional()
  @IsString()
  brands?: string;

  @ApiPropertyOptional({ example: 100000, description: "Minimum price in NGN" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min?: number;

  @ApiPropertyOptional({ example: 1000000, description: "Maximum price in NGN" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  max?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  inStock?: boolean;

  @ApiPropertyOptional({ example: 4, description: "Minimum rating (0-5)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rating?: number;

  @ApiPropertyOptional({
    enum: ["featured", "price_asc", "price_desc", "newest", "best_selling", "rating"],
    default: "featured",
  })
  @IsOptional()
  @IsEnum(["featured", "price_asc", "price_desc", "newest", "best_selling", "rating"])
  sort?: SortKey;

  @ApiPropertyOptional({ enum: ["new_arrival", "best_seller", "featured", "deal"] })
  @IsOptional()
  @IsEnum(["new_arrival", "best_seller", "featured", "deal"], { each: true })
  tag?: ProductTag;

  @ApiPropertyOptional({ enum: ["active", "draft", "archived"], description: "Admin only" })
  @IsOptional()
  @IsEnum(["active", "draft", "archived"])
  status?: ProductStatus;
}
