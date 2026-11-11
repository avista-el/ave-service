import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { SearchService } from "./search.service";
import { SearchController, AdminSearchController } from "./search.controller";

@Module({
  imports: [CatalogModule, PromotionsModule],
  providers: [SearchService],
  controllers: [SearchController, AdminSearchController],
  exports: [SearchService],
})
export class SearchModule {}
