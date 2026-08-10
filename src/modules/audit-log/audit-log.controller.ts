import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { AuditLogService } from "./audit-log.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { ApiPaginatedOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import { AuditLogEntryDto } from "../../common/swagger/swagger-response.dto";

class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: "product.update", description: "Filter by action prefix" })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ example: "admin:64a1...", description: "Filter by actor" })
  @IsOptional()
  @IsString()
  actor?: string;

  @ApiPropertyOptional({ example: "product", description: "Filter by entity type" })
  @IsOptional()
  @IsString()
  entityType?: string;
}

@ApiTags("Admin — Audit Log")
@ApiBearerAuth()
@Controller({ path: "admin/audit-log", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin")
@ApiForbiddenResponse({ description: "Super admin only", type: ApiErrorResponse })
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @ApiOperation({
    summary: "[Admin] Browse all audit log entries",
    description:
      "Returns a paginated, newest-first audit trail of all admin and system actions. Filterable by action, actor, and entity type.",
  })
  @ApiPaginatedOk(AuditLogEntryDto)
  findAll(@Query() query: AuditQueryDto) {
    return this.auditLogService.findAll(query, {
      action: query.action,
      actor: query.actor,
      entityType: query.entityType,
    });
  }

  @Get(":entityType/:entityId")
  @ApiOperation({ summary: "[Admin] Get audit trail for a specific entity" })
  @ApiParam({ name: "entityType", example: "product" })
  @ApiParam({ name: "entityId", description: "Entity ObjectId" })
  @ApiPaginatedOk(AuditLogEntryDto)
  findForEntity(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.auditLogService.findForEntity(entityType, entityId, pagination);
  }
}
