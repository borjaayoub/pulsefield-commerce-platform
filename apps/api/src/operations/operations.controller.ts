import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { RoleName } from '../generated/prisma/enums';
import { RecentStaffAuthenticationGuard } from '../identity/recent-staff-authentication.guard';
import { RoleAuthorizationGuard } from '../identity/role-authorization.guard';
import { RequireRoles } from '../identity/require-roles.decorator';
import {
  AuthenticatedSessionRequest,
  SessionAuthenticationGuard,
} from '../identity/session-authentication.guard';
import { OperationsQueryDto } from './operations.dto';
import { OperationsService } from './operations.service';

@ApiTags('Staff operations')
@ApiCookieAuth('session-cookie')
@Controller('staff/operations')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  private noStore(response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
  }

  @Get('catalog')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  catalog(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.catalog(query, request);
  }

  @Get('inventory')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  inventory(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.inventory(query, request);
  }

  @Get('reservations')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  reservations(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.reservations(query, request);
  }

  @Get('orders')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  orders(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.orders(query, request);
  }

  @Get('payments')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  payments(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.payments(query, request);
  }

  @Get('fulfillment')
  @RequireRoles(RoleName.ADMINISTRATOR, RoleName.FULFILLER)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  fulfillment(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.fulfillment(query, request);
  }

  @Get('audit')
  @RequireRoles(RoleName.ADMINISTRATOR)
  @ApiOkResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  audit(
    @Query() query: OperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.noStore(response);
    return this.operations.audit(query, request);
  }
}
