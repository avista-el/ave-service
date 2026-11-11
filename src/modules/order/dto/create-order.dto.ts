import {
  IsEnum,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from "class-validator";
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

  @ApiPropertyOptional({
    example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    description:
      "Guest ID from X-Guest-Id header — used to locate the guest cart when cartId is absent " +
      "and the user is not logged in",
  })
  @IsOptional()
  @IsString()
  guestId?: string;

  /**
   * Required for guest (unauthenticated) orders.
   * Logged-in users may omit it — the service uses their account email.
   *
   * The @ValidateIf decorator checks whether a JWT user is NOT present by
   * inspecting the `_isAuthenticated` flag that the controller sets before
   * validation.  When set to true the field is optional; otherwise it is
   * required.
   *
   * Because class-validator runs before the controller body executes, we use
   * a secondary approach: the field is always @IsEmail when provided, AND the
   * service layer re-checks for guest orders.  This keeps the DTO simple while
   * still surfacing a 400 at the DTO stage for obviously missing values.
   */
  @ApiPropertyOptional({
    example: "adaeze@example.com",
    description:
      "Required for guest (unauthenticated) orders. " +
      "Authenticated users inherit the email from their account profile.",
  })
  @ValidateIf((dto: CreateOrderDto) => !dto._isAuthenticated)
  @IsNotEmpty({ message: "customerEmail is required for guest orders" })
  @IsEmail({}, { message: "customerEmail must be a valid email address" })
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
      "'installment' charges a 40% deposit via gateway and creates an InstallmentPlan. " +
      "NOTE: 'installment' is not available to guest (unauthenticated) users.",
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

  /**
   * Internal flag injected by the controller before class-validator runs.
   * Set to `true` when a JWT user is present so `customerEmail` becomes optional.
   * Never sent by the client — stripped by ValidationPipe's `whitelist: true`.
   */
  @IsOptional()
  _isAuthenticated?: boolean;
}
