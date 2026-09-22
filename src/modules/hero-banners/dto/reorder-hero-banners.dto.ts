import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsMongoId } from "class-validator";

export class ReorderHeroBannersDto {
  @ApiProperty({
    description: "Banner IDs in the desired display order (first = sortOrder 0).",
    type: [String],
    example: ["665a1b2c3d4e5f6a7b8c9d0e", "665a1b2c3d4e5f6a7b8c9d0f"],
  })
  @IsArray()
  @IsMongoId({ each: true })
  ids: string[];
}
