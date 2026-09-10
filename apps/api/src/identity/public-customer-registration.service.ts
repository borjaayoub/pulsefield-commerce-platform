import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  CustomerRegistrationService,
  type CustomerRegistrationContext,
  type RegisterCustomerInput,
} from './customer-registration.service';

function containsNormalizedEmailTarget(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'emailNormalized' || value === 'User_emailNormalized_key';
  }

  if (Array.isArray(value)) {
    return value.some(containsNormalizedEmailTarget);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsNormalizedEmailTarget);
  }

  return false;
}

export function isNormalizedEmailConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    error.meta?.modelName === 'User' &&
    containsNormalizedEmailTarget(error.meta)
  );
}

@Injectable()
export class PublicCustomerRegistrationService {
  constructor(private readonly registrations: CustomerRegistrationService) {}

  async register(
    input: RegisterCustomerInput,
    context: CustomerRegistrationContext,
  ): Promise<void> {
    try {
      await this.registrations.register(input, context);
    } catch (error: unknown) {
      if (!isNormalizedEmailConflict(error)) {
        throw error;
      }
    }
  }
}
