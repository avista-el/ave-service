import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateDiscountDto {
  @ApiProperty({ example: "COOL20", description: "Unique discount code (stored uppercase)" })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ enum: ["percent", "fixed"], example: "percent" })
  @IsEnum(["percent", "fixed"])
  type: "percent" | "fixed";

  @ApiProperty({ example: 20, description: "Percentage (0–100) or fixed NGN amount" })
  @IsNumber()
  @Min(0)
  value: number;

  @ApiPropertyOptional({
    example: 200000,
    description: "Minimum order total in NGN required to use this code",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ example: "2026-08-01T00:00:00.000Z" })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: "2026-08-31T23:59:59.000Z" })
  @IsDateString()
  endsAt: string;

  @ApiPropertyOptional({ example: 500, description: "Max total redemptions — null for unlimited" })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @ApiPropertyOptional({ enum: ["all", "category", "product"], default: "all" })
  @IsOptional()
  @IsEnum(["all", "category", "product"])
  scope?: "all" | "category" | "product";

  @ApiPropertyOptional({
    type: [String],
    example: ["air-conditioners"],
    description: "Category slugs or product IDs depending on scope",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targets?: string[];

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
