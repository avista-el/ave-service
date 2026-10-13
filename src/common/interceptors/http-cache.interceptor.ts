import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";

/**
 * HTTP Cache-Control + ETag interceptor for **public, read-only** endpoints.
 *
 * Apply with  @UseInterceptors(HttpCacheInterceptor)  on any controller or
 * route that should be cacheable by CDNs / browsers.
 *
 * Behaviour:
 *  • Sets  Cache-Control: public, s-maxage=<TTL>, stale-while-revalidate=<SWR>
 *  • Computes a weak ETag from a SHA-1 of the serialised response body.
 *  • Responds 304 Not Modified when the client's If-None-Match matches the ETag,
 *    saving bandwidth on unchanged data.
 *  • Skips header injection entirely for non-GET requests (safety guard).
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  /**
   * s-maxage is the CDN TTL; stale-while-revalidate lets the CDN serve
   * a stale copy for up to SWR seconds while it fetches a fresh one.
   *
   * Defaults: 60 s fresh + 300 s stale-while-revalidate.
   * Override per-controller by extending and overriding these values.
   */
  protected readonly sMaxAge: number = 60;
  protected readonly staleWhileRevalidate: number = 300;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Only cache GET requests — never mutate-cache interactions.
    if (req.method !== "GET") return next.handle();

    return next.handle().pipe(
      tap((body) => {
        // Build a weak ETag from a SHA-1 hash of the stringified body.
        // Weak ETags are appropriate here because we don't guarantee byte-for-byte
        // identity (e.g., key order in JSON may vary), only semantic equivalence.
        const hash = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
        const etag = `W/"${hash}"`;

        // Respond 304 if the client already has this version.
        const ifNoneMatch = req.headers["if-none-match"];
        if (ifNoneMatch === etag) {
          res.status(304).end();
          return;
        }

        res.setHeader(
          "Cache-Control",
          `public, s-maxage=${this.sMaxAge}, stale-while-revalidate=${this.staleWhileRevalidate}`,
        );
        res.setHeader("ETag", etag);
        // Vary on Accept-Encoding so gzip / brotli variants get separate cache
        // entries at the CDN level.
        res.setHeader("Vary", "Accept-Encoding");
      }),
    );
  }
}

// ─── Preconfigured variants ───────────────────────────────────────────────────

/**
 * Long-lived variant for endpoints whose data changes at most once an hour
 * (categories, brands, hero banners).
 * s-maxage = 3600 s (1 h), stale-while-revalidate = 86400 s (24 h).
 */
@Injectable()
export class LongHttpCacheInterceptor extends HttpCacheInterceptor {
  protected override readonly sMaxAge = 3600;
  protected override readonly staleWhileRevalidate = 86_400;
}
