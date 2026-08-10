import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";

export class AddToCartDto {
  @ApiProperty({ example: "64a1f2c8e3b7a900120d9999", description: "Product ObjectId" })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class UpdateLineDto {
  @ApiProperty({ example: "64a1f2c8e3b7a900120d9999" })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ example: 2, description: "Set to 0 to remove the line" })
  @IsInt()
  @Min(0)
  quantity: number;
}

export class RemoveLineDto {
  @ApiProperty({ example: "64a1f2c8e3b7a900120d9999" })
  @IsString()
  @IsNotEmpty()
  productId: string;
}

export class ApplyPromoDto {
  @ApiProperty({ example: "COOL20" })
  @IsString()
  @IsNotEmpty()
  code: string;
}

export class MergeCartDto {
  @ApiProperty({
    example: "guest-uuid-1234",
    description: "X-Guest-Id header value from the guest session",
  })
  @IsString()
  @IsNotEmpty()
  guestId: string;
}
