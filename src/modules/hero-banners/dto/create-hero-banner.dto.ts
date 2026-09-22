import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from "class-validator";

export class CreateHeroBannerDto {
  @ApiProperty({ example: "Up to 30% off AC units" })
  @IsString()
  @IsNotEmpty()
  headline: string;

  @ApiPropertyOptional({ example: "Cool down for less this season." })
  @IsOptional()
  @IsString()
  subline?: string;

  @ApiPropertyOptional({ example: "https://res.cloudinary.com/..." })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ example: "/shop/air-conditioners" })
  @IsOptional()
  @IsString()
  link?: string;

  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @IsString()
  startsAt?: string;

  @ApiPropertyOptional({ example: "2026-09-30" })
  @IsOptional()
  @IsString()
  endsAt?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sortOrder?: number;
}
