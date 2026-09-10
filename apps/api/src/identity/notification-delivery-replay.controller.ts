import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCookieAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditedCommandContext } from '../audit/command-context';
import { RoleName } from '../generated/prisma/enums';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { BrowserRequestGuard } from './browser-request.guard';
import {
  NotificationDeliveryReplayAcceptedDto,
  NotificationDeliveryReplayParametersDto,
  ReplayNotificationDeliveryDto,
} from './notification-delivery-replay.dto';
import { NotificationDeliveryReplayService } from './notification-delivery-replay.service';
import { RecentStaffAuthenticationGuard } from './recent-staff-authentication.guard';
import { RequireRoles } from './require-roles.decorator';
import { RoleAuthorizationGuard } from './role-authorization.guard';
import {
  type AuthenticatedSessionRequest,
  SessionAuthenticationGuard,
} from './session-authentication.guard';
import { SessionService } from './session.service';

@ApiTags('Staff notification deliveries')
@ApiCookieAuth('session-cookie')
@Controller('staff/notification-deliveries')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class NotificationDeliveryReplayController {
  constructor(
    private readonly replays: NotificationDeliveryReplayService,
    private readonly sessions: SessionService,
  ) {}

  @Post(':deliveryId/replays')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiAcceptedResponse({ type: NotificationDeliveryReplayAcceptedDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  replay(
    @Param() parameters: NotificationDeliveryReplayParametersDto,
    @Body() body: ReplayNotificationDeliveryDto,
    @Req() request: AuthenticatedSessionRequest,
  ): Promise<NotificationDeliveryReplayAcceptedDto> {
    const session = request.authenticatedSession;
    if (!session) throw new Error('The session guard did not attach an authenticated session.');
    this.sessions.assertCsrf(session, request.header('x-csrf-token'));
    const requestId = request.header('x-request-id');
    if (!requestId) throw new Error('Request ID middleware did not attach an identifier.');
    const context: AuditedCommandContext = {
      requestId,
      correlationId: requestId,
      idempotencyKey: requestId,
      actor: { type: 'staff', id: session.user.id, roles: session.user.roles },
      reason: body.reason,
    };
    return this.replays.replay(parameters.deliveryId, context);
  }
}
