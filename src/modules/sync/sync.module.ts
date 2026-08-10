import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncSource, SyncSourceSchema, SyncRun, SyncRunSchema } from './schemas/sync.schema';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MediaModule } from '../media/media.module';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SyncSource.name, schema: SyncSourceSchema },
      { name: SyncRun.name, schema: SyncRunSchema },
    ]),
    CatalogModule,
    InventoryModule,
    AuditLogModule,
    MediaModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
