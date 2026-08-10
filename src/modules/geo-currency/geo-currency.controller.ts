import { Controller, Get, Ip } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { GeoCurrencyService } from "./geo-currency.service";
import { ApiEnvelopeOk } from "../../common/swagger/api-response.decorator";
import { CurrencyRateDto } from "../../common/swagger/swagger-response.dto";

@ApiTags("FX / Currency")
@Controller({ path: "fx", version: "1" })
export class GeoCurrencyController {
  constructor(private readonly service: GeoCurrencyService) {}

  @Get("rates")
  @ApiOperation({
    summary: "Get all currency rates (NGN base)",
    description: `Returns all supported currencies with their NGN conversion rates, symbol, and flag emoji. The frontend \`CurrencyProvider\` should fetch this on mount and replace the hardcoded rates in \`currency.tsx\`. Rates are refreshed from exchangerate.host every 4 hours via BullMQ cron.`,
  })
  @ApiEnvelopeOk(CurrencyRateDto, true)
  getRates() {
    return this.service.getRates();
  }

  @Get("detect")
  @ApiOperation({
    summary: "Detect suggested currency from caller IP",
    description:
      "Uses ipapi.co (or ipinfo.io) to look up the country for the request IP and returns the most appropriate currency code. Result should be cached client-side (cookie / localStorage) so this is only called once per session.",
  })
  detectCurrency(@Ip() ip: string) {
    return this.service.detectCurrency(ip);
  }
}
