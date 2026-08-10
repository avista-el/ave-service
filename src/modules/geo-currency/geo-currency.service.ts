import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FxRate, FxRateDocument } from './schemas/fx-rate.schema';

const SUPPORTED_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR'];

/** Hardcoded fallback rates relative to NGN (1 NGN = X currency) */
const FALLBACK_RATES: Record<string, number> = {
  NGN: 1,
  USD: 1 / 1550,
  GBP: 1 / 1980,
  EUR: 1 / 1700,
  GHS: 1 / 118,
  KES: 1 / 12,
  ZAR: 1 / 85,
};

@Injectable()
export class GeoCurrencyService {
  private readonly logger = new Logger(GeoCurrencyService.name);

  constructor(
    @InjectModel(FxRate.name)
    private readonly fxModel: Model<FxRateDocument>,
    private readonly config: ConfigService,
  ) {}

  // ─── FX rates ─────────────────────────────────────────────────────────────

  /** Returns all supported currency rates — frontend caches in localStorage */
  async getRates(): Promise<
    { currency: string; rate: number; symbol: string; flag: string }[]
  > {
    const stored = await this.fxModel.find().lean();
    const rateMap: Record<string, number> = {};
    for (const r of stored) rateMap[r.currency] = r.rate;

    return SUPPORTED_CURRENCIES.map((code) => ({
      currency: code,
      rate: rateMap[code] ?? FALLBACK_RATES[code] ?? 1,
      symbol: this.symbolFor(code),
      flag: this.flagFor(code),
    }));
  }

  /** Scheduled every 4 hours — refreshes rates from Open Exchange Rates or exchangerate.host */
  @Cron(CronExpression.EVERY_4_HOURS)
  async refreshRates(): Promise<void> {
    this.logger.log('Refreshing FX rates…');
    try {
      // Try exchangerate.host (free tier, no key needed for basic access)
      const res = await fetch(
        'https://api.exchangerate.host/latest?base=NGN&symbols=' +
          SUPPORTED_CURRENCIES.filter((c) => c !== 'NGN').join(','),
      );
      if (!res.ok) throw new Error('exchangerate.host returned non-200');

      const data = (await res.json()) as {
        success: boolean;
        rates: Record<string, number>;
      };

      if (!data.success) throw new Error('exchangerate.host: success=false');

      const now = new Date();
      const ops = Object.entries(data.rates).map(([currency, rate]) => ({
        updateOne: {
          filter: { currency },
          update: { $set: { rate, refreshedAt: now, source: 'exchangerate.host' } },
          upsert: true,
        },
      }));
      // Always ensure NGN = 1
      ops.push({
        updateOne: {
          filter: { currency: 'NGN' },
          update: { $set: { rate: 1, refreshedAt: now, source: 'base' } },
          upsert: true,
        },
      });

      await this.fxModel.bulkWrite(ops);
      this.logger.log(`FX rates refreshed — ${ops.length} currencies`);
    } catch (err) {
      this.logger.warn(`FX refresh failed, using existing rates: ${(err as Error).message}`);
    }
  }

  // ─── Geolocation: detect country/currency from IP ─────────────────────────

  async detectCurrency(ip: string): Promise<string> {
    if (ip === '127.0.0.1' || ip === '::1') return 'NGN';
    try {
      const provider = this.config.get<string>('geolocation.provider', 'ipapi');
      if (provider === 'ipinfo') {
        const token = this.config.get<string>('geolocation.ipinfoToken');
        const res = await fetch(
          `https://ipinfo.io/${ip}?token=${token}`,
        );
        const data = (await res.json()) as { country?: string };
        return this.countryToCurrency(data.country ?? 'NG');
      }
      // Default: ipapi.co (no key needed for 1000 req/day)
      const res = await fetch(`https://ipapi.co/${ip}/json/`);
      const data = (await res.json()) as { currency?: string };
      return data.currency ?? 'NGN';
    } catch {
      return 'NGN';
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private countryToCurrency(country: string): string {
    const map: Record<string, string> = {
      NG: 'NGN', US: 'USD', GB: 'GBP', GH: 'GHS', KE: 'KES', ZA: 'ZAR',
      DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
    };
    return map[country] ?? 'USD';
  }

  private symbolFor(code: string): string {
    const map: Record<string, string> = {
      NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: 'GH₵', KES: 'KSh', ZAR: 'R',
    };
    return map[code] ?? code;
  }

  private flagFor(code: string): string {
    const map: Record<string, string> = {
      NGN: '🇳🇬', USD: '🇺🇸', GBP: '🇬🇧', EUR: '🇪🇺', GHS: '🇬🇭', KES: '🇰🇪', ZAR: '🇿🇦',
    };
    return map[code] ?? '🏳';
  }
}
