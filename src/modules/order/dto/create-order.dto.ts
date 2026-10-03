import { IsEnum, IsEmail, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PaymentMethod } from "../schemas/order.schema";

export class ShippingAddressDto {
  @ApiProperty({ example: "Adaeze Okonkwo" }) @IsString() @IsNotEmpty() fullName: string;
  @ApiProperty({ example: "+2348011223344" }) @IsString() @IsNotEmpty() phone: string;
  @ApiProperty({ example: "12 Aminu Kano Crescent" }) @IsString() @IsNotEmpty() line1: string;
  @ApiPropertyOptional({ example: "Suite 4B" }) @IsOptional() @IsString() line2?: string;
  @ApiProperty({ example: "Abuja" }) @IsString() @IsNotEmpty() city: string;
  @ApiProperty({ example: "FCT" }) @IsString() @IsNotEmpty() state: string;
  @ApiPropertyOptional({ example: "Nigeria", default: "Nigeria" })
  @IsOptional()
  @IsString()
  country?: string;
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    example: "64a1f2c8e3b7a900120d1111",
    description: "Cart id — items loaded from this cart",
  })
  @IsOptional()
  @IsString()
  cartId?: string;

  @ApiPropertyOptional({ example: "adaeze@example.com" })
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @ApiPropertyOptional({ example: "Adaeze Okonkwo" })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({
    enum: ["paystack", "flutterwave", "pay_on_delivery", "installment"],
    example: "paystack",
    description:
      "Payment method. 'paystack' and 'flutterwave' redirect to a hosted payment page. " +
      "'pay_on_delivery' skips gateway — order goes straight to awaiting_delivery_payment. " +
      "'installment' charges a 40% deposit via gateway and creates an InstallmentPlan.",
  })
  @IsEnum(["paystack", "flutterwave", "pay_on_delivery", "installment"])
  paymentMethod: PaymentMethod;

  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress: ShippingAddressDto;

  @ApiPropertyOptional({ example: "COOL20" })
  @IsOptional()
  @IsString()
  promoCode?: string;
}
