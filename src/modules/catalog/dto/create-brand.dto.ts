import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateBrandDto {
  @ApiProperty({ example: "Hisense" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: "https://res.cloudinary.com/..." })
  @IsOptional()
  @IsString()
  logoUrl?: string;
}
