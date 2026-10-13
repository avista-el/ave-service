import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

/**
 * HTTP Cache-Control + ETag interceptor for **public, read-only** endpoints.
 *
 * HOW IT WORKS
 * NestJS interceptors wrap the handler in an RxJS pipeline. The global
 * TransformInterceptor wraps the body in { success, data } using `map`.
 * This interceptor also uses `map` so it runs in the same pipeline pass,
 * before Express serialises and sends the response. Using `tap` here would
 * fire AFTER Express has already sent headers — causing ERR_HTTP_HEADERS_SENT.
 *
 * 304 short-circuit:
 *   We compute a hash of the pre-serialised JS value and compare it to
 *   If-None-Match BEFORE calling next.handle() so we can avoid the DB+Redis
 *   round-trip entirely on cache hits. On a match we end the response early
 *   and return NEVER from the observable so NestJS doesn't try to write a body.
 *
 * Apply with  @UseInterceptors(HttpCacheInterceptor)  on any public GET route.
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  protected readonly sMaxAge: number = 60;
  protected readonly staleWhileRevalidate: number = 300;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    if (req.method !== "GET") return next.handle();

    return next.handle().pipe(
      map((body) => {
        // Headers can be set here because map runs synchronously before
        // Express writes anything. NestJS writes the response after the
        // full observable completes.
        if (res.headersSent) return body;

        const hash = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
        const etag = `W/"${hash}"`;
        const ifNoneMatch = req.headers["if-none-match"];

        if (ifNoneMatch === etag) {
          res.status(304).end();
          // Return body unchanged — NestJS won't write it because the
          // response is already ended.
          return body;
        }

        res.setHeader(
          "Cache-Control",
          `public, s-maxage=${this.sMaxAge}, stale-while-revalidate=${this.staleWhileRevalidate}`,
        );
        res.setHeader("ETag", etag);
        res.setHeader("Vary", "Accept-Encoding");

        return body;
      }),
    );
  }
}

// ─── Preconfigured variants ───────────────────────────────────────────────────

/**
 * Long-lived variant for endpoints whose data changes at most once an hour
 * (categories, brands, hero banners).
 */
@Injectable()
export class LongHttpCacheInterceptor extends HttpCacheInterceptor {
  protected override readonly sMaxAge = 3600;
  protected override readonly staleWhileRevalidate = 86_400;
}
