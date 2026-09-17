import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RoleName } from '../generated/prisma/enums';
import { REQUIRED_ROLES_METADATA } from '../identity/require-roles.decorator';
import { OperationsController } from './operations.controller';
import {
  OperationsQueryDto,
  ReconciliationAttentionCategory,
  ReconciliationQueryDto,
} from './operations.dto';

describe('OperationsController contract', () => {
  const service = {
    catalog: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    inventory: jest.fn(),
    reservations: jest.fn(),
    orders: jest.fn(),
    payments: jest.fn(),
    reconciliation: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    fulfillment: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    audit: jest.fn(),
  };
  const controller = new OperationsController(service as never);
  const response = { setHeader: jest.fn() };
  const request = {
    authenticatedSession: { user: { id: 'actor', roles: [RoleName.ADMINISTRATOR] } },
  } as never;

  it('marks operational responses no-store and delegates the request projection', async () => {
    await controller.catalog({ pageSize: 25 }, request, response as never);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(service.catalog).toHaveBeenCalledWith({ pageSize: 25 }, request);
  });

  it('marks reconciliation no-store and delegates its bounded query', async () => {
    const query = {
      pageSize: 10,
      attentionCategory: ReconciliationAttentionCategory.PAYMENT_FAILED,
    };
    await controller.reconciliation(query, request, response as never);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(service.reconciliation).toHaveBeenCalledWith(query, request);
  });

  it('publishes the administrator and fulfiller role matrix', () => {
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_METADATA, OperationsController.prototype.catalog),
    ).toEqual([RoleName.ADMINISTRATOR]);
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_METADATA, OperationsController.prototype.inventory),
    ).toEqual([RoleName.ADMINISTRATOR]);
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_METADATA, OperationsController.prototype.fulfillment),
    ).toEqual([RoleName.ADMINISTRATOR, RoleName.FULFILLER]);
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_METADATA, OperationsController.prototype.reconciliation),
    ).toEqual([RoleName.ADMINISTRATOR]);
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_METADATA, OperationsController.prototype.audit),
    ).toEqual([RoleName.ADMINISTRATOR]);
  });

  it('validates bounded operation page sizes with a default of 25', async () => {
    expect(new OperationsQueryDto().pageSize).toBe(25);
    expect((await validate(plainToInstance(OperationsQueryDto, { pageSize: 100 }))).length).toBe(0);
    expect(
      (await validate(plainToInstance(OperationsQueryDto, { pageSize: 101 }))).length,
    ).toBeGreaterThan(0);
    expect(
      (await validate(plainToInstance(OperationsQueryDto, { pageSize: 0 }))).length,
    ).toBeGreaterThan(0);
  });

  it('validates reconciliation filters against finite status sets', async () => {
    expect(new ReconciliationQueryDto().pageSize).toBe(25);
    expect(
      (
        await validate(
          plainToInstance(ReconciliationQueryDto, {
            paymentStatus: 'FAILED',
            orderStatus: 'MANUAL_RESOLUTION',
            compensationStatus: 'REQUIRED',
            attentionCategory: 'COMPENSATION_REQUIRED',
          }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(ReconciliationQueryDto, {
            compensationStatus: 'UNKNOWN',
            attentionCategory: 'RETRY_NOW',
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(plainToInstance(ReconciliationQueryDto, { sku: 'IGNORED' }), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  });
});
