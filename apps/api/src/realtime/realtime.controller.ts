import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleName } from '../generated/prisma/enums';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { RecentStaffAuthenticationGuard } from '../identity/recent-staff-authentication.guard';
import { RequireRoles } from '../identity/require-roles.decorator';
import { RoleAuthorizationGuard } from '../identity/role-authorization.guard';
import { SessionAuthenticationGuard } from '../identity/session-authentication.guard';
import { RealtimeRelayService } from './realtime-relay.service';

@ApiTags('Staff realtime')
@ApiCookieAuth('session-cookie')
@Controller('staff/realtime')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class RealtimeController {
  constructor(private readonly relay: RealtimeRelayService) {}

  @Get('diagnostics')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401 })
  @ApiResponse({ status: 403 })
  async diagnostics(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.relay.diagnostics();
  }
}
