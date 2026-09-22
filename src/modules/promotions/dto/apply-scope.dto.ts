import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, ValidateIf } from "class-validator";
import { ApplicationScope } from "../schemas/discount-code.schema";

export class ApplyScopeDto {
  @ApiProperty({
    enum: ["product", "category", "catalogue"],
    description:
      "Granularity of the application. " +
      "'product' targets a single product by its ObjectId string. " +
      "'category' targets all products sharing a categorySlug (current and future). " +
      "'catalogue' applies the discount to every active product sitewide.",
    example: "category",
  })
  @IsEnum(["product", "category", "catalogue"])
  scope: ApplicationScope;

  @ApiPropertyOptional({
    description:
      "Required when scope is 'product' (product ObjectId) or 'category' (categorySlug). " +
      "Omit or pass null when scope is 'catalogue'.",
    example: "air-conditioners",
  })
  @ValidateIf((o: ApplyScopeDto) => o.scope !== "catalogue")
  @IsString()
  @IsOptional()
  targetId?: string;
}
