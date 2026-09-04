import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import { SyncService } from "./sync.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "../auth/strategies/jwt.strategy";
import {
  ApiEnvelopeOk,
  ApiEnvelopeCreated,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";
import { SyncRunSummaryDto } from "../../common/swagger/swagger-response.dto";

class CreateSourceDto {
  @ApiProperty({ example: "Q3 Price List" }) @IsString() @IsNotEmpty() name: string;
  @ApiProperty({ example: "https://docs.google.com/spreadsheets/d/..." })
  @IsString()
  @IsNotEmpty()
  sheetUrl: string;
  @ApiProperty({ example: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" })
  @IsString()
  @IsNotEmpty()
  sheetId: string;
  @ApiProperty({ example: { sku: "A", title: "B", price: "C", stock: "D" } })
  @IsObject()
  columnMapping: Record<string, string>;
  @ApiPropertyOptional({ enum: ["manual", "hourly", "daily"], default: "manual" })
  @IsOptional()
  @IsString()
  schedule?: "manual" | "hourly" | "daily";
}

class TriggerRunDto {
  @ApiProperty({
    description: "Parsed sheet rows — array of objects keyed by column header",
    type: [Object],
  })
  @IsArray()
  rows: Record<string, string>[];
}

class ApproveRunDto {
  @ApiProperty({
    type: [String],
    example: ["AV-1000:price", "AV-1001:stock"],
    description: 'Array of "<sku>:<field>" change keys to commit for existing products',
  })
  @IsArray()
  @IsString({ each: true })
  selectedChanges: string[];

  @ApiProperty({
    type: [String],
    example: ["AV-0001", "AV-0002"],
    description: "SKUs from newProducts to create as new catalogue entries",
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  selectedNewSkus?: string[];
}

@ApiTags("Admin — Sync")
@ApiBearerAuth()
@Controller({ path: "admin/sync", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get("sources")
  @ApiOperation({ summary: "[Admin] List saved Google Sheet connections" })
  @ApiEnvelopeOk(Object, true)
  findSources() {
    return this.syncService.findAllSources();
  }

  @Post("sources")
  @ApiOperation({
    summary: "[Admin] Connect a Google Sheet as a sync source",
    description:
      "Saves the sheet URL, column-mapping, and optional schedule. The mapping object keys are system field names (sku, title, price, stock, images, description) and values are the matching spreadsheet column letters or headers.",
  })
  @ApiEnvelopeCreated(Object)
  createSource(@Body() dto: CreateSourceDto) {
    return this.syncService.createSource(dto);
  }

  @Patch("sources/:id")
  @ApiOperation({ summary: "[Admin] Update a sync source (column mapping, schedule)" })
  @ApiParam({ name: "id", description: "SyncSource ObjectId" })
  @ApiEnvelopeOk(Object)
  updateSource(@Param("id") id: string, @Body() dto: Partial<CreateSourceDto>) {
    return this.syncService.updateSource(id, dto);
  }

  @Get("runs")
  @ApiOperation({
    summary: "[Admin] List recent sync runs",
    description:
      "Returns the 50 most recent sync runs, newest first. Optionally filter by sourceId.",
  })
  @ApiEnvelopeOk(SyncRunSummaryDto, true)
  findRuns(@Query("sourceId") sourceId?: string) {
    return this.syncService.findAllRuns(sourceId);
  }

  @Get("runs/:id")
  @ApiOperation({ summary: "[Admin] Get full sync run detail (diff table)" })
  @ApiParam({ name: "id", description: "SyncRun ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiNotFoundResponse({ description: "Sync run not found", type: ApiErrorResponse })
  getRun(@Param("id") id: string) {
    return this.syncService.findRunById(id);
  }

  @Post("sources/:sourceId/run")
  @ApiOperation({
    summary: "[Admin] Trigger a sync preview",
    description:
      "Computes a field-level diff between the supplied sheet rows and the live products collection. Writes a SyncRun with status `pending_review`. Nothing is committed to products yet — the admin must call the approve endpoint.",
  })
  @ApiParam({ name: "sourceId", description: "SyncSource ObjectId" })
  @ApiEnvelopeCreated(SyncRunSummaryDto)
  triggerRun(
    @Param("sourceId") sourceId: string,
    @Body() dto: TriggerRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.syncService.executeRun(sourceId, user.sub, dto.rows);
  }

  @Post("runs/:id/approve")
  @ApiOperation({
    summary: "[Admin] Approve and publish selected changes",
    description:
      "Commits the selected field changes to the live `products` collection. Stock writes go through the same concurrency-safe path used by the checkout flow. Logs every applied change to the audit log.",
  })
  @ApiParam({ name: "id", description: "SyncRun ObjectId" })
  @ApiEnvelopeOk(Object)
  @ApiBadRequestResponse({ description: "Run not in reviewable state", type: ApiErrorResponse })
  approveRun(@Param("id") id: string, @Body() dto: ApproveRunDto, @CurrentUser() user: JwtPayload) {
    return this.syncService.approveSyncRun(
      id,
      dto.selectedChanges,
      user.sub,
      dto.selectedNewSkus ?? [],
    );
  }
}
