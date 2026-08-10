import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bull';
import {
  QUEUE_SEARCH_INDEX,
  JOB_INDEX_PRODUCT,
  JOB_DELETE_INDEX,
} from '../jobs.constants';
import { SearchService } from '../../search/search.service';
import { Product, ProductDocument } from '../../catalog/schemas/product.schema';

@Processor(QUEUE_SEARCH_INDEX)
export class SearchIndexProcessor {
  private readonly logger = new Logger(SearchIndexProcessor.name);

  constructor(
    private readonly searchService: SearchService,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  @Process(JOB_INDEX_PRODUCT)
  async indexProduct(job: Job<{ productId: string }>): Promise<void> {
    const product = await this.productModel
      .findById(job.data.productId)
      .lean() as ProductDocument | null;
    if (!product) return;
    await this.searchService.indexProduct(product);
    this.logger.debug(`Indexed product ${product.sku}`);
  }

  @Process(JOB_DELETE_INDEX)
  async deleteFromIndex(job: Job<{ productId: string }>): Promise<void> {
    await this.searchService.deleteFromIndex(job.data.productId);
    this.logger.debug(`Removed product ${job.data.productId} from index`);
  }
}
