import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
import { InventoryOperationsService } from './inventory-operations.service';
import { InventoryOperationsQueryDto } from './inventory-operations.dto';
import {
  InventoryLowStockPageDto,
  InventoryReconciliationPageDto,
  InventoryTransferPageDto,
  InventoryTransferResponseDto,
} from './inventory-operations.response.dto';
import { InventoryProblemResponses } from './inventory-swagger.decorators';

@ApiTags('Staff inventory operations')
@ApiCookieAuth('session-cookie')
@Controller('staff/operations')
@UseGuards(
  BrowserRequestGuard,
  SessionAuthenticationGuard,
  RoleAuthorizationGuard,
  RecentStaffAuthenticationGuard,
)
export class InventoryOperationsReadController {
  constructor(private readonly service: InventoryOperationsService) {}
  @Get('inventory-low-stock')
  @ApiOkResponse({
    type: InventoryLowStockPageDto,
    headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
  })
  @InventoryProblemResponses(400, 401, 403)
  @RequireRoles(RoleName.ADMINISTRATOR)
  low(
    @Query() query: InventoryOperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const session = request.authenticatedSession;
    if (!session) throw new Error('Missing session.');
    return this.service.lowStock({ id: session.user.id, roles: session.user.roles }, query);
  }
  @Get('inventory-reconciliation')
  @ApiOkResponse({
    type: InventoryReconciliationPageDto,
    headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
  })
  @InventoryProblemResponses(400, 401, 403)
  @RequireRoles(RoleName.ADMINISTRATOR)
  reconcile(
    @Query() query: InventoryOperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const session = request.authenticatedSession;
    if (!session) throw new Error('Missing session.');
    return this.service.reconciliation({ id: session.user.id, roles: session.user.roles }, query);
  }
  @Get('inventory-transfers')
  @ApiOkResponse({
    type: InventoryTransferPageDto,
    headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
  })
  @InventoryProblemResponses(400, 401, 403)
  @RequireRoles(RoleName.ADMINISTRATOR)
  queue(
    @Query() query: InventoryOperationsQueryDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const session = request.authenticatedSession;
    if (!session) throw new Error('Missing session.');
    return this.service.listTransfers({ id: session.user.id, roles: session.user.roles }, query);
  }
  @Get('inventory-transfers/:id')
  @ApiOkResponse({
    type: InventoryTransferResponseDto,
    headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
  })
  @InventoryProblemResponses(400, 401, 403, 404)
  @RequireRoles(RoleName.ADMINISTRATOR)
  detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const session = request.authenticatedSession;
    if (!session) throw new Error('Missing session.');
    return this.service.getTransfer(id, { id: session.user.id, roles: session.user.roles });
  }
}
