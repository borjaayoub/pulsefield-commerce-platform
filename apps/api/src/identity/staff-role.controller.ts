import { Body, Controller, Delete, Param, Put, Req, UseGuards } from '@nestjs/common';
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
import {
  ChangeStaffRoleDto,
  StaffRoleAssignmentDto,
  StaffRoleParametersDto,
} from './staff-role.dto';
import { StaffRoleManagementService } from './staff-role-management.service';

@ApiTags('Staff roles')
@ApiCookieAuth('session-cookie')
@Controller('staff/users')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class StaffRoleController {
  constructor(
    private readonly staffRoles: StaffRoleManagementService,
    private readonly sessions: SessionService,
  ) {}

  @Put(':userId/roles/:role')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse({ type: StaffRoleAssignmentDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  grant(
    @Param() parameters: StaffRoleParametersDto,
    @Body() body: ChangeStaffRoleDto,
    @Req() request: AuthenticatedSessionRequest,
  ): Promise<StaffRoleAssignmentDto> {
    const session = this.session(request);
    this.sessions.assertCsrf(session, request.header('x-csrf-token'));
    return this.staffRoles.grant(
      parameters.userId,
      parameters.role,
      this.context(request, body.reason),
    );
  }

  @Delete(':userId/roles/:role')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse({ type: StaffRoleAssignmentDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  revoke(
    @Param() parameters: StaffRoleParametersDto,
    @Body() body: ChangeStaffRoleDto,
    @Req() request: AuthenticatedSessionRequest,
  ): Promise<StaffRoleAssignmentDto> {
    const session = this.session(request);
    this.sessions.assertCsrf(session, request.header('x-csrf-token'));
    return this.staffRoles.revoke(
      parameters.userId,
      parameters.role,
      this.context(request, body.reason),
    );
  }

  private session(request: AuthenticatedSessionRequest) {
    if (!request.authenticatedSession) {
      throw new Error('The session guard did not attach an authenticated session.');
    }
    return request.authenticatedSession;
  }

  private context(request: AuthenticatedSessionRequest, reason: string): AuditedCommandContext {
    const session = this.session(request);
    const requestId = request.header('x-request-id');
    if (!requestId) throw new Error('Request ID middleware did not attach an identifier.');
    return {
      requestId,
      correlationId: requestId,
      idempotencyKey: requestId,
      actor: {
        type: 'staff',
        id: session.user.id,
        roles: session.user.roles,
      },
      reason,
    };
  }
}
