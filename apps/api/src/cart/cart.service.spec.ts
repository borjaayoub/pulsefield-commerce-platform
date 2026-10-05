import { Prisma } from '../generated/prisma/client';
import { isMarketSelectionContention } from './cart.service';

describe('market selection transaction contention', () => {
  function error(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError('Database operation failed.', {
      code,
      meta,
      clientVersion: '7.10.0',
    });
  }
  it.each(['40001', '40P01'])('recognizes raw-query adapter SQLSTATE %s', (code) => {
    expect(
      isMarketSelectionContention(
        error('P2010', { driverAdapterError: { cause: { originalCode: code } } }),
      ),
    ).toBe(true);
    expect(isMarketSelectionContention(error('P2010', { code }))).toBe(true);
  });
  it('recognizes Prisma transaction contention but preserves constraints and unrelated errors', () => {
    expect(isMarketSelectionContention(error('P2034'))).toBe(true);
    expect(
      isMarketSelectionContention(
        error('P2010', { driverAdapterError: { cause: { originalCode: '23514' } } }),
      ),
    ).toBe(false);
    expect(isMarketSelectionContention(error('P2010'))).toBe(false);
    expect(isMarketSelectionContention(error('P2002'))).toBe(false);
    expect(isMarketSelectionContention(new Error('40001'))).toBe(false);
  });
});
