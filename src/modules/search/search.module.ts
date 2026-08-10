import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { SearchService } from './search.service';
import { SearchController, AdminSearchController } from './search.controller';

@Module({
  imports: [CatalogModule],
  providers: [SearchService],
  controllers: [SearchController, AdminSearchController],
  exports: [SearchService],
})
export class SearchModule {}
