import {
  Controller,
  Get,
  Delete,
  Param,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from "@nestjs/swagger";
import { InstallmentService } from "./installment.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import {
  ApiEnvelopeOk,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";

@ApiTags("Installment Plans")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "orders/:orderId/installment-plan", version: "1" })
export class InstallmentController {
  constructor(private readonly installmentService: InstallmentService) {}

  @Get()
  @ApiOperation({
    summary: "Get the instalment plan for an order",
    description: "Returns the full InstallmentPlan document including the repayment schedule.",
  })
  @ApiParam({ name: "orderId", description: "Order ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Plan not found", type: ApiErrorResponse })
  getPlan(@Param("orderId") orderId: string) {
    return this.installmentService.findByOrder(orderId);
  }

  @Delete("cancel")
  @ApiOperation({
    summary: "Customer-initiated plan cancellation",
    description:
      "Cancels an active instalment plan that has no missed or overdue payments. " +
      "A 5% administrative forfeit is applied to the amount paid to date. " +
      "The remaining balance minus forfeit is flagged for refund.",
  })
  @ApiParam({ name: "orderId", description: "Order ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiBadRequestResponse({
    description: "Plan not active / already has missed payments",
    type: ApiErrorResponse,
  })
  async cancelPlan(
    @Param("orderId") orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const plan = await this.installmentService.findByOrder(orderId);
    if (!plan) throw new Error("Plan not found");
    return this.installmentService.cancelPlan(
      (plan._id as import("mongoose").Types.ObjectId).toString(),
      user.sub,
    );
  }
}
