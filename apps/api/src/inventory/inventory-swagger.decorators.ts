import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { InventoryProblemDetailsDto } from './inventory-operations.response.dto';

export function InventoryProblemResponses(...statuses: number[]) {
  return applyDecorators(
    ApiExtraModels(InventoryProblemDetailsDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        content: {
          'application/problem+json': {
            schema: { $ref: getSchemaPath(InventoryProblemDetailsDto) },
          },
        },
        headers: {
          'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
        },
      }),
    ),
  );
}
