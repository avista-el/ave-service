import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FxRate, FxRateSchema } from './schemas/fx-rate.schema';
import { GeoCurrencyService } from './geo-currency.service';
import { GeoCurrencyController } from './geo-currency.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: FxRate.name, schema: FxRateSchema }]),
  ],
  providers: [GeoCurrencyService],
  controllers: [GeoCurrencyController],
  exports: [GeoCurrencyService],
})
export class GeoCurrencyModule {}
