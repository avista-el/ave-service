import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

export interface LogEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  note?: string | null;
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly logModel: Model<AuditLogDocument>,
  ) {}

  /** Append a new entry — fire-and-forget safe (catch errors internally) */
  async log(entry: LogEntry): Promise<void> {
    try {
      await this.logModel.create({ ...entry, createdAt: new Date() });
    } catch {
      // Never let audit logging crash the main flow
    }
  }

  async findForEntity(
    entityType: string,
    entityId: string,
    pagination: PaginationDto,
  ) {
    const filter: FilterQuery<AuditLogDocument> = { entityType, entityId };
    const [items, total] = await Promise.all([
      this.logModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit ?? 20)
        .lean(),
      this.logModel.countDocuments(filter),
    ]);
    return paginate(items, total, pagination);
  }

  async findAll(
    pagination: PaginationDto,
    filters: { action?: string; actor?: string; entityType?: string } = {},
  ) {
    const filter: FilterQuery<AuditLogDocument> = {};
    if (filters.action) filter.action = new RegExp(filters.action, 'i');
    if (filters.actor) filter.actor = new RegExp(filters.actor, 'i');
    if (filters.entityType) filter.entityType = filters.entityType;

    const [items, total] = await Promise.all([
      this.logModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit ?? 20)
        .lean(),
      this.logModel.countDocuments(filter),
    ]);
    return paginate(items, total, pagination);
  }
}
