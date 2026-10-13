import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "crypto";
import type { Request, Response } from "express";
import { EMPTY, Observable, of } from "rxjs";
import { switchMap } from "rxjs/operators";

/**
 * HTTP Cache-Control + ETag interceptor for public, read-only GET endpoints.
 *
 * Execution order:
 *   NestJS global interceptors wrap per-route ones (onion model).
 *   TransformInterceptor (global) is the outer layer — its map() runs last.
 *   This interceptor (per-route) is the inner layer — its switchMap() runs
 *   first on the raw handler return value before the { success, data } wrap.
 *   The ETag therefore hashes the raw data, which is stable across requests.
 *
 * 304 handling:
 *   We check If-None-Match after the handler runs but before NestJS writes
 *   the body. On a match we call res.end() and return EMPTY — NestJS never
 *   attempts to write a response body on an already-ended response.
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

    const ifNoneMatch = req.headers["if-none-match"];

    return next.handle().pipe(
      switchMap((body) => {
        if (res.headersSent) return of(body);

        const hash = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
        const etag = `W/"${hash}"`;

        // 304: end the response and return EMPTY so NestJS writes no body.
        if (ifNoneMatch === etag) {
          res.status(304).end();
          return EMPTY;
        }

        res.setHeader(
          "Cache-Control",
          `public, s-maxage=${this.sMaxAge}, stale-while-revalidate=${this.staleWhileRevalidate}`,
        );
        res.setHeader("ETag", etag);
        res.setHeader("Vary", "Accept-Encoding");

        return of(body);
      }),
    );
  }
}

@Injectable()
export class LongHttpCacheInterceptor extends HttpCacheInterceptor {
  protected override readonly sMaxAge = 3600;
  protected override readonly staleWhileRevalidate = 86_400;
}
