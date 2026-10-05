import type { InternationalMarketCode } from '@pulse-field/contracts';
import { ValidateBy, type ValidationOptions } from 'class-validator';

export const EU_DESTINATIONS = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;
export const SHIPPING_COUNTRIES = ['US', 'MA', 'GB', ...EU_DESTINATIONS];

export function destinationMarket(country: string): InternationalMarketCode | undefined {
  if (country === 'US' || country === 'MA') return country;
  if (country === 'GB') return 'UK';
  return (EU_DESTINATIONS as readonly string[]).includes(country) ? 'EU' : undefined;
}

const POSTAL_PATTERNS: Readonly<Record<string, RegExp>> = {
  US: /^\d{5}(?:-\d{4})?$/u,
  MA: /^\d{5}$/u,
  GB: /^(?:GIR ?0AA|(?:[A-PR-UWYZ]\d\d?|[A-PR-UWYZ][A-HK-Y]\d\d?|[A-PR-UWYZ]\d[A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y]\d[ABEHMNPRVWXY]) ?\d[ABD-HJLNP-UW-Z]{2})$/u,
  AT: /^\d{4}$/u,
  BE: /^\d{4}$/u,
  BG: /^\d{4}$/u,
  CY: /^\d{4}$/u,
  DK: /^\d{4}$/u,
  HU: /^\d{4}$/u,
  LU: /^\d{4}$/u,
  SI: /^\d{4}$/u,
  DE: /^\d{5}$/u,
  EE: /^\d{5}$/u,
  ES: /^\d{5}$/u,
  FI: /^\d{5}$/u,
  FR: /^\d{5}$/u,
  HR: /^\d{5}$/u,
  IT: /^\d{5}$/u,
  RO: /^\d{6}$/u,
  CZ: /^\d{3} ?\d{2}$/u,
  GR: /^\d{3} ?\d{2}$/u,
  SK: /^\d{3} ?\d{2}$/u,
  SE: /^\d{3} ?\d{2}$/u,
  PL: /^\d{2}-\d{3}$/u,
  PT: /^\d{4}-\d{3}$/u,
  LT: /^(?:LT-)?\d{5}$/u,
  LV: /^(?:LV-)?\d{4}$/u,
  NL: /^[1-9]\d{3} ?[A-Z]{2}$/u,
  MT: /^[A-Z]{3} ?\d{4}$/u,
  IE: /^(?:D6W|[AC-FHKNPRTV-Y]\d{2}) ?[0-9AC-FHKNPRTV-Y]{4}$/u,
};

export function validPostalCode(country: unknown, value: unknown): boolean {
  return (
    typeof country === 'string' &&
    typeof value === 'string' &&
    value.length <= 16 &&
    (POSTAL_PATTERNS[country]?.test(value) ?? false)
  );
}

export function CountryPostalCode(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'countryPostalCode',
      validator: {
        validate: (value: unknown, args) =>
          validPostalCode(args && Reflect.get(args.object, 'countryCode'), value),
        defaultMessage: () => 'postalCode must match the destination country format',
      },
    },
    options,
  );
}

export function CountryState(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'countryState',
      validator: {
        validate: (value: unknown, args) => {
          const country = args && Reflect.get(args.object, 'countryCode');
          return country === 'US'
            ? typeof value === 'string' && /^[A-Z]{2}$/u.test(value)
            : value === undefined || (typeof value === 'string' && value.length <= 120);
        },
        defaultMessage: () => 'state must match the destination country requirements',
      },
    },
    options,
  );
}
