import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleName } from '../generated/prisma/enums';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { RecentStaffAuthenticationGuard } from '../identity/recent-staff-authentication.guard';
import { RequireRoles } from '../identity/require-roles.decorator';
import { RoleAuthorizationGuard } from '../identity/role-authorization.guard';
import {
  SessionAuthenticationGuard,
  type AuthenticatedSessionRequest,
} from '../identity/session-authentication.guard';
import { SessionService } from '../identity/session.service';
import { InventoryOperationsService } from './inventory-operations.service';
import {
  CreateInventoryTransferDto,
  InventoryAdjustmentDto,
  InventoryThresholdDto,
  InventoryTransferTransitionDto,
} from './inventory-operations.dto';
import {
  InventoryBalanceAdjustmentResponseDto,
  InventoryThresholdResponseDto,
  InventoryTransferCommandResponseDto,
} from './inventory-operations.response.dto';
import { InventoryProblemResponses } from './inventory-swagger.decorators';

@ApiTags('Staff inventory operations')
@ApiCookieAuth('session-cookie')
@Controller('staff/inventory')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class InventoryOperationsController {
  constructor(
    private readonly service: InventoryOperationsService,
    private readonly sessions: SessionService,
  ) {}
  private actor(request: AuthenticatedSessionRequest) {
    const session = request.authenticatedSession;
    if (!session) throw new Error('Missing session.');
    return { session, actor: { id: session.user.id, roles: session.user.roles } };
  }
  private headers(
    request: AuthenticatedSessionRequest,
    key: string | undefined,
    resource: 'inventory' | 'transfer',
  ) {
    const { session } = this.actor(request);
    this.sessions.assertCsrf(session, request.header('x-csrf-token'));
    const requestId = request.header('x-request-id');
    if (!requestId) throw new Error('Missing request ID.');
    if (!key) throw new HttpException('If-Match is required.', HttpStatus.PRECONDITION_REQUIRED);
    const match = key.match(new RegExp(`^"${resource}-([1-9][0-9]*)"$`, 'u'));
    if (!match) throw new BadRequestException('Malformed If-Match.');
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) throw new BadRequestException('Malformed If-Match.');
    return { requestId, version, key };
  }
  @Post('balances/:id/adjustments')
  @HttpCode(200)
  @ApiOkResponse({
    type: InventoryBalanceAdjustmentResponseDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    schema: { type: 'string', example: '"inventory-2"' },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @InventoryProblemResponses(400, 401, 403, 404, 409, 428)
  @RequireRoles(RoleName.ADMINISTRATOR)
  adjust(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: InventoryAdjustmentDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { actor } = this.actor(request);
    const headers = this.headers(request, ifMatch, 'inventory');
    response.setHeader('Cache-Control', 'no-store');
    return this.service
      .adjust(id, body, headers.version, actor, key, headers.requestId)
      .then((result) => {
        if (result && typeof result === 'object' && 'etag' in result)
          response.setHeader('ETag', String(result.etag));
        return result;
      });
  }
  @Post('balances/:id/thresholds')
  @HttpCode(200)
  @ApiOkResponse({
    type: InventoryThresholdResponseDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    schema: { type: 'string', example: '"inventory-2"' },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @InventoryProblemResponses(400, 401, 403, 404, 409, 428)
  @RequireRoles(RoleName.ADMINISTRATOR)
  threshold(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: InventoryThresholdDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { actor } = this.actor(request);
    const headers = this.headers(request, ifMatch, 'inventory');
    response.setHeader('Cache-Control', 'no-store');
    return this.service
      .threshold(id, body, headers.version, actor, key, headers.requestId)
      .then((result) => {
        if (result && typeof result === 'object' && 'etag' in result)
          response.setHeader('ETag', String(result.etag));
        return result;
      });
  }
  @Post('transfers')
  @HttpCode(201)
  @ApiCreatedResponse({
    type: InventoryTransferCommandResponseDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @InventoryProblemResponses(400, 401, 403, 404, 409)
  @RequireRoles(RoleName.ADMINISTRATOR)
  create(
    @Body() body: CreateInventoryTransferDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { actor } = this.actor(request);
    const requestId = request.header('x-request-id');
    if (!requestId) throw new Error('Missing request ID.');
    this.sessions.assertCsrf(this.actor(request).session, request.header('x-csrf-token'));
    response.setHeader('Cache-Control', 'no-store');
    return this.service.createTransfer(body, actor, key, requestId).then((result) => {
      if (result && typeof result === 'object' && 'etag' in result)
        response.setHeader('ETag', String(result.etag));
      return result;
    });
  }
  @Post('transfers/:id/transitions')
  @HttpCode(200)
  @ApiOkResponse({
    type: InventoryTransferCommandResponseDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    schema: { type: 'string', example: '"transfer-2"' },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @InventoryProblemResponses(400, 401, 403, 404, 409, 428)
  @RequireRoles(RoleName.ADMINISTRATOR)
  transition(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: InventoryTransferTransitionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { actor } = this.actor(request);
    const headers = this.headers(request, ifMatch, 'transfer');
    response.setHeader('Cache-Control', 'no-store');
    return this.service
      .transition(id, body, headers.version, actor, key, headers.requestId)
      .then((result) => {
        if (result && typeof result === 'object' && 'etag' in result)
          response.setHeader('ETag', String(result.etag));
        return result;
      });
  }
}
