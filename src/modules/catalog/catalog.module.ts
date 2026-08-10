import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Brand, BrandSchema } from './schemas/brand.schema';
import { Category, CategorySchema } from './schemas/category.schema';
import { CatalogService } from './catalog.service';
import { CatalogController, AdminCatalogController } from './catalog.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Brand.name, schema: BrandSchema },
      { name: Category.name, schema: CategorySchema },
    ]),
  ],
  providers: [CatalogService],
  controllers: [CatalogController, AdminCatalogController],
  exports: [CatalogService, MongooseModule],
})
export class CatalogModule {}
