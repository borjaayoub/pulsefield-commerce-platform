import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('system')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Return the local Phase 1 API foundation status.' })
  @ApiOkResponse({
    description: 'The process has started and is serving the versioned API prefix.',
  })
  check(): Record<string, unknown> {
    return {
      status: 'ok',
      service: 'pulse-field-api',
      profile: 'zero-cost-local',
      version: 'v1',
      dependencies: {
        database: 'configured',
        queueRedis: 'configured',
        ephemeralRedis: 'configured',
        smtp: 'mailpit-only',
        telemetry: 'jaeger-local',
      },
    };
  }
}
