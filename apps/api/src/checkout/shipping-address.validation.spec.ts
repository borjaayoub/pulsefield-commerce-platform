import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ShippingAddressDto } from './checkout.dto';
import {
  SHIPPING_COUNTRIES,
  validPostalCode,
  destinationMarket,
} from './shipping-address.validation';

const EXAMPLES = {
  US: '94105',
  MA: '20000',
  GB: 'SW1A 1AA',
  AT: '1010',
  BE: '1000',
  BG: '1000',
  CY: '1000',
  DK: '1000',
  HU: '1000',
  LU: '1000',
  SI: '1000',
  DE: '10115',
  EE: '10111',
  ES: '28001',
  FI: '00100',
  FR: '75001',
  HR: '10000',
  IT: '00100',
  RO: '010001',
  CZ: '110 00',
  GR: '105 58',
  SK: '811 01',
  SE: '111 22',
  PL: '00-001',
  PT: '1000-001',
  LT: 'LT-01100',
  LV: 'LV-1000',
  NL: '1012 AB',
  MT: 'VLT 1117',
  IE: 'D02 X285',
};
describe('destination format validation', () => {
  it('has fixtures for every allowed destination', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...SHIPPING_COUNTRIES].sort());
  });
  it.each(Object.entries(EXAMPLES))('accepts %s and rejects malformed input', (country, postal) => {
    expect(validPostalCode(country, postal)).toBe(true);
    expect(validPostalCode(country, 'invalid-postal')).toBe(false);
    expect(destinationMarket(country)).toBe(
      country === 'GB' ? 'UK' : country === 'US' || country === 'MA' ? country : 'EU',
    );
  });
  it.each(['SW1A', 'SW1A 1A', 'SW1A 1!A', 'ZZ1 1ZZ'])(
    'rejects incomplete or malformed GB postal %s',
    (value) => {
      expect(validPostalCode('GB', value)).toBe(false);
    },
  );
  it('requires US state but accepts omitted regional state and normalizes postal input', async () => {
    const address = {
      fullName: 'Buyer',
      line1: '1 Test Road',
      line2: '',
      city: 'City',
      countryCode: 'GB',
      postalCode: ' sw1a 1aa ',
    };
    const uk = plainToInstance(ShippingAddressDto, address);
    expect(await validate(uk)).toEqual([]);
    expect(uk.postalCode).toBe('SW1A 1AA');
    expect(
      await validate(
        plainToInstance(ShippingAddressDto, { ...address, countryCode: 'US', postalCode: '94105' }),
      ),
    ).not.toEqual([]);
  });
  it.each(['EU', 'UK', 'CA', 'us', ''])('rejects unsupported destination %s', (country) => {
    expect(destinationMarket(country)).toBeUndefined();
    expect(validPostalCode(country, '12345')).toBe(false);
  });
});
