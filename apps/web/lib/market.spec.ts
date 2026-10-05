import { DESTINATIONS, destinationMarket, formatMoney, marketUrl, parseMarket } from './market';

describe('regional presentation boundaries', () => {
  it('preserves filters and replaces only market selection', () => {
    expect(marketUrl('/catalog?category=trail&market=US', 'MA')).toBe(
      '/catalog?category=trail&market=MA',
    );
    expect(parseMarket(null)).toBe('US');
    expect(parseMarket('ma')).toBe('US');
    expect(parseMarket('UK')).toBe('UK');
  });
  it('maps all 30 destinations to the approved commercial markets', () => {
    expect(Object.keys(DESTINATIONS)).toHaveLength(30);
    for (const country of Object.keys(DESTINATIONS) as (keyof typeof DESTINATIONS)[]) {
      expect(destinationMarket(country)).toBe(
        country === 'US' ? 'US' : country === 'MA' ? 'MA' : country === 'GB' ? 'UK' : 'EU',
      );
    }
  });
  it.each(['USD', 'MAD', 'EUR', 'GBP'] as const)(
    'formats original %s minor units without converting',
    (currency) => {
      expect(formatMoney(12345, currency)).toContain(currency);
      expect(formatMoney(12345, currency)).toContain('123.45');
    },
  );
});
