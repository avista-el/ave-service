import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation, ApiForbiddenResponse } from "@nestjs/swagger";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import {
  DashboardMetricsDto,
  RevenuePointDto,
  CategoryMixDto,
} from "../../common/swagger/swagger-response.dto";

class RevenueSeriesQueryDto {
  @ApiPropertyOptional({
    example: 7,
    description: "Number of past months to include (1–24)",
    minimum: 1,
    maximum: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number;
}

@ApiTags("Admin — Analytics")
@ApiBearerAuth()
@Controller({ path: "admin/analytics", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser", "support_agent")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("metrics")
  @ApiOperation({
    summary: "[Admin] Dashboard KPI cards",
    description:
      "Returns revenue, order count, units sold, AOV, pending count, and low-stock alert count. Used by the admin dashboard home.",
  })
  @ApiEnvelopeOk(DashboardMetricsDto)
  getMetrics() {
    return this.analyticsService.getDashboardMetrics();
  }

  @Get("revenue-series")
  @ApiOperation({
    summary: "[Admin] Revenue and orders per month (last N months)",
    description: "Used by the sales trend chart on the admin dashboard.",
  })
  @ApiEnvelopeOk(RevenuePointDto, true)
  getRevenueSeries(@Query() query: RevenueSeriesQueryDto) {
    return this.analyticsService.getRevenueSeries(query.months ?? 7);
  }

  @Get("category-mix")
  @ApiOperation({
    summary: "[Admin] Revenue breakdown by category",
    description:
      "Returns percentage of total revenue per category. Used by the dashboard pie chart.",
  })
  @ApiEnvelopeOk(CategoryMixDto, true)
  getCategoryMix() {
    return this.analyticsService.getCategoryMix();
  }

  @Get("top-products")
  @ApiOperation({ summary: "[Admin] Top 10 products by revenue" })
  @ApiEnvelopeOk(Object, true)
  getTopProducts() {
    return this.analyticsService.getTopProducts();
  }

  @Get("low-stock")
  @ApiOperation({
    summary: "[Admin] Low-stock product list",
    description:
      "Products where available stock (stock - reserved) is ≤ 5. Same data as the dashboard alert widget.",
  })
  @ApiEnvelopeOk(Object, true)
  getLowStock() {
    return this.analyticsService.getLowStockProducts();
  }
}
