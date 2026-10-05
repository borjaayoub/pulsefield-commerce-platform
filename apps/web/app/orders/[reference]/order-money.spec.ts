import { formatOrderMoney } from './order-timeline';

describe('guest order original-currency formatting', () => {
  it.each([
    ['USD', 11192, '$111.92'],
    ['MAD', 115200, 'MAD 1,152.00'],
    ['EUR', 11800, '€118.00'],
    ['GBP', 10500, '£105.00'],
  ] as const)('formats stored %s amounts without converting them', (currency, minor, expected) => {
    expect(formatOrderMoney(minor, currency).replaceAll('\u00a0', ' ')).toBe(expected);
  });
});
