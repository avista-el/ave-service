/**
 * Shared business-rule constants.
 *
 * These are the single source of truth for thresholds that were previously
 * hardcoded across multiple services. Import from here instead of inlining
 * magic numbers.
 *
 * For env-based overrides, see configuration.ts where these are also exposed
 * via ConfigService keys (storefront.lowStockThreshold, etc.).
 */

/** Products with available stock ≤ this value are flagged "low_stock". */
export const LOW_STOCK_THRESHOLD = 5;

/** Orders above this NGN subtotal qualify for free delivery in Abuja (FCT). */
export const FREE_DELIVERY_THRESHOLD = 500_000;
