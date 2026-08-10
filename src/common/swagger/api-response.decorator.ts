/**
 * Reusable Swagger helpers used across all controllers.
 * Keeps controller files clean — one decorator call instead of 4.
 */
import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiCreatedResponse,
  getSchemaPath,
  ApiProperty,
} from '@nestjs/swagger';

// ─── Standard envelope schema ─────────────────────────────────────────────────

export class ApiErrorResponse {
  @ApiProperty({ example: false }) success: boolean;
  @ApiProperty({ example: 400 }) statusCode: number;
  @ApiProperty({ example: 'Validation failed' }) message: string;
  @ApiProperty({ example: '/v1/auth/login' }) path: string;
  @ApiProperty({ example: '2026-08-09T12:00:00.000Z' }) timestamp: string;
}

export class PaginationMeta {
  @ApiProperty({ example: 1 }) page: number;
  @ApiProperty({ example: 20 }) limit: number;
  @ApiProperty({ example: 100 }) total: number;
  @ApiProperty({ example: 5 }) pages: number;
}

// ─── Envelope factory decorators ─────────────────────────────────────────────

/**
 * Wraps a response class in the standard { success, data } envelope for 200 OK.
 * @example @ApiEnvelopeOk(ProductResponseDto)
 */
export function ApiEnvelopeOk<T extends Type<unknown>>(model: T, isArray = false) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          data: isArray
            ? { type: 'array', items: { $ref: getSchemaPath(model) } }
            : { $ref: getSchemaPath(model) },
        },
      },
    }),
  );
}

/**
 * Wraps a response class in the standard { success, data } envelope for 201 Created.
 */
export function ApiEnvelopeCreated<T extends Type<unknown>>(model: T) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiCreatedResponse({
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: getSchemaPath(model) },
        },
      },
    }),
  );
}

/**
 * Wraps a paginated response: { success, data: { items[], total, page, limit, pages } }
 */
export function ApiPaginatedOk<T extends Type<unknown>>(model: T) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      schema: {
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: getSchemaPath(model) } },
              total: { type: 'integer', example: 100 },
              page: { type: 'integer', example: 1 },
              limit: { type: 'integer', example: 20 },
              pages: { type: 'integer', example: 5 },
            },
          },
        },
      },
    }),
  );
}
