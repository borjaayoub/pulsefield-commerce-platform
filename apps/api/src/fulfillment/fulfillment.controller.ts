import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { RoleName } from '../generated/prisma/enums';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { RecentStaffAuthenticationGuard } from '../identity/recent-staff-authentication.guard';
import { RequireRoles } from '../identity/require-roles.decorator';
import {
  SessionAuthenticationGuard,
  type AuthenticatedSessionRequest,
} from '../identity/session-authentication.guard';
import { RoleAuthorizationGuard } from '../identity/role-authorization.guard';
import { SessionService } from '../identity/session.service';
import { FulfillmentGroupDto, FulfillmentTransitionDto } from './fulfillment.dto';
import { FulfillmentRequestError } from './fulfillment.errors';
import { FulfillmentService } from './fulfillment.service';

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^"fulfillment-([1-9][0-9]*)"$/u.exec(value);
  if (!match) throw new FulfillmentRequestError();
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw new FulfillmentRequestError();
  return version;
}

@ApiTags('Staff fulfillment')
@ApiCookieAuth('session-cookie')
@Controller('staff/fulfillment-groups')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class FulfillmentController {
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly sessions: SessionService,
  ) {}

  @Post(':id/transitions')
  @HttpCode(HttpStatus.OK)
  @RequireRoles(RoleName.FULFILLER)
  @ApiOkResponse({ type: FulfillmentGroupDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 404, type: ProblemDetailsDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  @ApiResponse({ status: 428, type: ProblemDetailsDto })
  async transition(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: FulfillmentTransitionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FulfillmentGroupDto> {
    response.setHeader('Cache-Control', 'no-store');
    const session = request.authenticatedSession;
    if (!session) throw new Error('The session guard did not attach an authenticated session.');
    this.sessions.assertCsrf(session, request.header('x-csrf-token'));
    const requestId = request.header('x-request-id');
    if (!requestId) throw new Error('Request ID middleware did not attach an identifier.');
    const result = await this.fulfillment.transition(
      {
        fulfillmentGroupId: id,
        expectedVersion: parseVersion(ifMatch),
        idempotencyKey,
        targetStatus: body.targetStatus,
        reason: body.reason,
        carrierCode: body.carrierCode,
        trackingReference: body.trackingReference,
      },
      {
        requestId,
        correlationId: requestId,
        idempotencyKey: idempotencyKey ?? 'missing-idempotency-key',
        actor: { type: 'staff', id: session.user.id, roles: session.user.roles },
        reason: body.reason,
      },
    );
    response.setHeader('ETag', `"fulfillment-${result.version}"`);
    return result;
  }
}
