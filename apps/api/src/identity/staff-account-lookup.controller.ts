import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditedCommandContext } from '../audit/command-context';
import { RoleName } from '../generated/prisma/enums';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { BrowserRequestGuard } from './browser-request.guard';
import { RecentStaffAuthenticationGuard } from './recent-staff-authentication.guard';
import { RequireRoles } from './require-roles.decorator';
import { RoleAuthorizationGuard } from './role-authorization.guard';
import {
  type AuthenticatedSessionRequest,
  SessionAuthenticationGuard,
} from './session-authentication.guard';
import { SessionService } from './session.service';
import { MaskedStaffAccountDto, StaffAccountLookupDto } from './staff-account-lookup.dto';
import { StaffAccountLookupService } from './staff-account-lookup.service';

@ApiTags('Staff accounts')
@ApiCookieAuth('session-cookie')
@Controller('staff/user-lookups')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class StaffAccountLookupController {
  constructor(
    private readonly lookups: StaffAccountLookupService,
    private readonly sessions: SessionService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse({ type: MaskedStaffAccountDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 404, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  lookup(
    @Body() body: StaffAccountLookupDto,
    @Req() request: AuthenticatedSessionRequest,
  ): Promise<MaskedStaffAccountDto> {
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
    return this.lookups.findByEmail(body.email, context);
  }
}
