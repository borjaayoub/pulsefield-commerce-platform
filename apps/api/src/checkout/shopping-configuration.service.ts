import { BadRequestException, Injectable } from '@nestjs/common';
import type { InternationalMarketCode, SupportedCurrency } from '@pulse-field/contracts';
import type { Prisma } from '../generated/prisma/client';

export const SHOPPING_MARKETS = ['US', 'MA', 'EU', 'UK'] as const;
const CURRENCIES = { US: 'USD', MA: 'MAD', EU: 'EUR', UK: 'GBP' } as const;

export class CommerceConfigurationUnavailableError extends Error {
  readonly code = 'COMMERCE_CONFIGURATION_UNAVAILABLE';
  constructor() {
    super('Commerce configuration is temporarily unavailable.');
  }
}

export interface ShoppingConfiguration {
  readonly market: InternationalMarketCode;
  readonly currency: SupportedCurrency;
  readonly configurationId: string;
  readonly configurationVersion: number;
  readonly priceBookVersionId: string;
  readonly allocationPolicyVersionId: string;
  readonly taxRateBasisPoints: number;
  readonly shippingBaseMinor: number;
  readonly freeShippingThresholdMinor: number;
  readonly heavyThresholdGrams: number;
  readonly heavySurchargeBasisPoints: number;
  readonly reservationDurationSeconds: number;
}

export function validateShoppingMarket(value: string): InternationalMarketCode {
  const code = SHOPPING_MARKETS.find((market) => market === value);
  if (!code) throw new BadRequestException();
  return code;
}

export function shoppingInventoryFilter(
  config: ShoppingConfiguration,
): Prisma.InventoryBalanceWhereInput {
  return {
    warehouse: {
      status: 'ACTIVE',
      allocationPolicyAssignments: {
        some: {
          policyVersionId: config.allocationPolicyVersionId,
          policyVersion: { lifecycle: 'ACTIVE' },
        },
      },
    },
  };
}

/** Caller owns the transaction: never opens an independent configuration snapshot. */
@Injectable()
export class ShoppingConfigurationService {
  async resolve(tx: Prisma.TransactionClient, value: string): Promise<ShoppingConfiguration> {
    const market = validateShoppingMarket(value);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const configs = await tx.commerceMarketVersion.findMany({
      where: { market: { code: market }, lifecycle: 'ACTIVE', effectiveFrom: { lte: clock.now } },
      include: {
        market: true,
        priceBookVersion: { include: { priceBook: true } },
        allocationPolicyVersion: { include: { policy: true } },
      },
    });
    const config = configs[0];
    if (
      configs.length !== 1 ||
      !config ||
      config.market.currencyCode !== CURRENCIES[market] ||
      config.priceBookVersion.lifecycle !== 'ACTIVE' ||
      config.allocationPolicyVersion.lifecycle !== 'ACTIVE' ||
      config.priceBookVersion.priceBook.marketCode !== market ||
      config.priceBookVersion.priceBook.currencyCode !== CURRENCIES[market] ||
      config.allocationPolicyVersion.policy.destinationRegion !==
        (market === 'US' ? 'US' : market === 'MA' ? 'MOROCCO' : 'EU') ||
      config.calculationVersion !== 'international-commerce-v1' ||
      config.taxTreatment !== 'exclusive'
    )
      throw new CommerceConfigurationUnavailableError();
    return Object.freeze({
      market,
      currency: CURRENCIES[market],
      configurationId: config.id,
      configurationVersion: config.version,
      priceBookVersionId: config.priceBookVersionId,
      allocationPolicyVersionId: config.allocationPolicyVersionId,
      taxRateBasisPoints: config.taxRateBasisPoints,
      shippingBaseMinor: config.shippingBaseMinor,
      freeShippingThresholdMinor: config.freeShippingThresholdMinor,
      heavyThresholdGrams: config.heavyThresholdGrams,
      heavySurchargeBasisPoints: config.heavySurchargeBasisPoints,
      reservationDurationSeconds: config.reservationDurationSeconds,
    });
  }
}
