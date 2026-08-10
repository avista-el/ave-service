import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SubcategoryInputDto {
  @ApiProperty({ example: "s1" }) @IsString() @IsNotEmpty() id: string;
  @ApiProperty({ example: '50" – 59"' }) @IsString() @IsNotEmpty() name: string;
  @ApiProperty({ example: "50-59-inch" }) @IsString() @IsNotEmpty() slug: string;
}

export class CreateCategoryDto {
  @ApiProperty({ example: "Televisions" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Smart 4K and QLED panels from 32" to 85".' })
  @IsOptional()
  @IsString()
  blurb?: string;

  @ApiPropertyOptional({ example: "https://res.cloudinary.com/..." })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: "Parent category id — omit for top-level" })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ type: [SubcategoryInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubcategoryInputDto)
  subcategories?: SubcategoryInputDto[];

  @ApiPropertyOptional({ example: 1, description: "Display order in category list" })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}
