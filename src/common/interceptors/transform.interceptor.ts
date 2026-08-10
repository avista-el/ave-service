import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

/**
 * Wraps every successful response in the standard envelope:
 * { success: true, data: <payload>, message?: <optional> }
 *
 * Frontend expects this shape everywhere per the PRD API contract.
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // If the handler already wrapped the response (e.g., returning {success,data})
        // pass it through unchanged to avoid double-wrapping
        if (
          data !== null &&
          typeof data === 'object' &&
          'success' in data &&
          'data' in data
        ) {
          return data as ApiResponse<T>;
        }
        return { success: true, data };
      }),
    );
  }
}
