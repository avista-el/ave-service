/**
 * Response shape DTOs used only for Swagger documentation.
 * These mirror what controllers actually return — they are not used at runtime.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Auth ─────────────────────────────────────────────────────────────────────

export class AuthUserDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d1234' }) id: string;
  @ApiProperty({ example: 'Adaeze Okonkwo' }) name: string;
  @ApiProperty({ example: 'adaeze@example.com' }) email: string;
  @ApiProperty({ example: 'customer', enum: ['super_admin', 'merchandiser', 'support_agent', 'customer'] })
  role: string;
}

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }) accessToken: string;
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }) refreshToken: string;
  @ApiProperty({ type: AuthUserDto }) user: AuthUserDto;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export class BrandDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d5678' }) id: string;
  @ApiProperty({ example: 'Hisense' }) name: string;
  @ApiProperty({ example: 'hisense' }) slug: string;
  @ApiPropertyOptional({ example: 'https://res.cloudinary.com/...' }) logoUrl?: string;
}

export class SubcategoryDto {
  @ApiProperty({ example: 's1' }) id: string;
  @ApiProperty({ example: '50" – 59"' }) name: string;
  @ApiProperty({ example: '50-59-inch' }) slug: string;
}

export class CategoryDto {
  @ApiProperty({ example: 'c1' }) id: string;
  @ApiProperty({ example: 'Televisions' }) name: string;
  @ApiProperty({ example: 'tvs' }) slug: string;
  @ApiPropertyOptional({ example: 'Smart 4K and QLED panels from 32" to 85".' }) blurb?: string;
  @ApiPropertyOptional({ example: 'https://res.cloudinary.com/...' }) imageUrl?: string;
  @ApiProperty({ type: [SubcategoryDto] }) subcategories: SubcategoryDto[];
}

export class SpecDto {
  @ApiProperty({ example: 'Screen Size' }) label: string;
  @ApiProperty({ example: '55"' }) value: string;
}

export class RatingDto {
  @ApiProperty({ example: 4.6 }) average: number;
  @ApiProperty({ example: 128 }) count: number;
}

export class ProductResponseDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d9999' }) id: string;
  @ApiProperty({ example: 'hisense-55-4k-uhd-smart-tv-a6k' }) slug: string;
  @ApiProperty({ example: 'AV-1000' }) sku: string;
  @ApiProperty({ example: 'Hisense 55" 4K UHD Smart TV A6K' }) title: string;
  @ApiProperty({ type: BrandDto }) brand: BrandDto;
  @ApiProperty({ type: CategoryDto }) category: CategoryDto;
  @ApiPropertyOptional({ type: SubcategoryDto }) subcategory?: SubcategoryDto;
  @ApiProperty({ example: 585000, description: 'Base price in NGN' }) priceBase: number;
  @ApiPropertyOptional({ example: 699000, description: 'Crossed-out "was" price in NGN' }) compareAtPrice?: number;
  @ApiProperty({ type: [String], example: ['https://res.cloudinary.com/...'] }) images: string[];
  @ApiProperty({ type: [SpecDto] }) specs: SpecDto[];
  @ApiProperty({ example: 'Built for Nigerian homes...' }) description: string;
  @ApiProperty({ example: 'in_stock', enum: ['in_stock', 'low_stock', 'out_of_stock', 'preorder'] })
  stockStatus: string;
  @ApiProperty({ type: RatingDto }) rating: RatingDto;
  @ApiProperty({ type: [String], example: ['deal', 'best_seller'] }) tags: string[];
}

// ─── Cart ─────────────────────────────────────────────────────────────────────

export class CartLineDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d9999' }) productId: string;
  @ApiProperty({ example: 'AV-1000' }) sku: string;
  @ApiProperty({ example: 'Hisense 55" 4K UHD Smart TV A6K' }) title: string;
  @ApiProperty({ example: 'https://res.cloudinary.com/...' }) image: string;
  @ApiProperty({ example: 585000 }) unitPrice: number;
  @ApiProperty({ example: 2 }) quantity: number;
  @ApiProperty({ example: 1170000 }) lineTotal: number;
}

export class CartResponseDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d1111' }) id: string;
  @ApiProperty({ type: [CartLineDto] }) lines: CartLineDto[];
  @ApiProperty({ example: 3 }) count: number;
  @ApiProperty({ example: 1755000 }) subtotal: number;
  @ApiProperty({ example: 0 }) discountAmount: number;
  @ApiProperty({ example: 1755000 }) total: number;
  @ApiPropertyOptional({ example: 'COOL20' }) promoCode?: string;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export class OrderResponseDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d2222' }) id: string;
  @ApiProperty({ example: 'AV-2701' }) orderNumber: string;
  @ApiProperty({ example: 'pending_payment', enum: ['pending_payment', 'paid', 'failed', 'abandoned', 'fulfilled', 'cancelled', 'refunded'] })
  status: string;
  @ApiProperty({ example: 1755000 }) total: number;
  @ApiProperty({ example: 'paystack', enum: ['paystack', 'flutterwave'] }) paymentProvider: string;
  @ApiProperty({ example: 'AV-2701-K3F9X' }) paymentReference: string;
  @ApiPropertyOptional({ example: 'https://checkout.paystack.com/...' }) checkoutUrl?: string;
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export class InitializePaymentResponseDto {
  @ApiProperty({ example: 'https://checkout.paystack.com/0peioxfhpn' }) checkoutUrl: string;
  @ApiProperty({ example: 'AV-2701-K3F9X' }) reference: string;
}

// ─── FX / Currency ────────────────────────────────────────────────────────────

export class CurrencyRateDto {
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ example: 0.000645, description: '1 NGN expressed in this currency' }) rate: number;
  @ApiProperty({ example: '$' }) symbol: string;
  @ApiProperty({ example: '🇺🇸' }) flag: string;
}

// ─── Promotions ───────────────────────────────────────────────────────────────

export class PromoValidateResponseDto {
  @ApiProperty({ example: 'COOL20' }) code: string;
  @ApiProperty({ example: 50000, description: 'Amount to subtract from order total in NGN' }) discountAmount: number;
}

// ─── Media ────────────────────────────────────────────────────────────────────

export class SignedUploadParamsDto {
  @ApiProperty({ example: '556971725361323' }) apiKey: string;
  @ApiProperty({ example: 'rw4hznem' }) cloudName: string;
  @ApiProperty({ example: 1722000000 }) timestamp: number;
  @ApiProperty({ example: 'abc123def456...' }) signature: string;
  @ApiProperty({ example: 'alphavista/products' }) folder: string;
}

export class UploadResponseDto {
  @ApiProperty({ example: 'alphavista/products/abc123' }) publicId: string;
  @ApiProperty({ example: 'https://res.cloudinary.com/rw4hznem/image/upload/...' }) secureUrl: string;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export class DashboardMetricsDto {
  @ApiProperty({ example: 45200000 }) revenueBase: number;
  @ApiProperty({ example: 24 }) orderCount: number;
  @ApiProperty({ example: 67 }) unitsSold: number;
  @ApiProperty({ example: 1883333 }) averageOrderBase: number;
  @ApiProperty({ example: 3 }) pendingCount: number;
  @ApiProperty({ example: 5 }) lowStockCount: number;
}

export class RevenuePointDto {
  @ApiProperty({ example: 'Aug' }) month: string;
  @ApiProperty({ example: 2026 }) year: number;
  @ApiProperty({ example: 29450000 }) revenue: number;
  @ApiProperty({ example: 69 }) orders: number;
}

export class CategoryMixDto {
  @ApiProperty({ example: 'Televisions' }) name: string;
  @ApiProperty({ example: 34, description: 'Percentage of total revenue' }) value: number;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export class SearchResultDto {
  @ApiProperty({ type: [ProductResponseDto] }) items: ProductResponseDto[];
  @ApiProperty({ example: 42 }) total: number;
  @ApiProperty({ example: 1 }) page: number;
  @ApiProperty({ example: 20 }) limit: number;
  @ApiPropertyOptional({ example: 'hisense tv' }) query?: string;
}

export class SuggestItemDto {
  @ApiProperty({ example: 'Hisense 55" 4K UHD Smart TV A6K' }) title: string;
  @ApiProperty({ example: 'hisense-55-4k-uhd-smart-tv-a6k' }) slug: string;
  @ApiProperty({ example: 'Televisions' }) categoryName: string;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export class SyncRunSummaryDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d3333' }) id: string;
  @ApiProperty({ example: 'pending_review', enum: ['pending_review', 'partially_approved', 'published', 'failed'] })
  status: string;
  @ApiProperty({ example: 3 }) newProductsCount: number;
  @ApiProperty({ example: 12 }) updatedFieldsCount: number;
  @ApiProperty({ example: 8 }) unchangedCount: number;
  @ApiProperty({ example: 1 }) errorsCount: number;
  @ApiProperty({ example: '2026-08-09T12:00:00.000Z' }) createdAt: string;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export class AuditLogEntryDto {
  @ApiProperty({ example: '64a1f2c8e3b7a900120d4444' }) id: string;
  @ApiProperty({ example: 'admin:64a1f2c8e3b7a900120d1234' }) actor: string;
  @ApiProperty({ example: 'product.update' }) action: string;
  @ApiProperty({ example: 'product' }) entityType: string;
  @ApiProperty({ example: '64a1f2c8e3b7a900120d9999' }) entityId: string;
  @ApiPropertyOptional() before?: Record<string, unknown>;
  @ApiPropertyOptional() after?: Record<string, unknown>;
  @ApiProperty({ example: '2026-08-09T12:00:00.000Z' }) createdAt: string;
}
