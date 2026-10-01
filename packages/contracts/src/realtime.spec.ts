import { isRealtimeInvalidationEnvelope } from './realtime';

describe('realtime invalidation envelope', () => {
  it('accepts the bounded version-one browser shape', () => {
    expect(
      isRealtimeInvalidationEnvelope({
        version: 1,
        streamId: 'a'.repeat(16),
        sequence: 1,
        topics: ['catalog'],
      }),
    ).toBe(true);
  });

  it('rejects duplicate, private, malformed, and unsupported protocol data', () => {
    expect(isRealtimeInvalidationEnvelope({ version: 2, streamId: 'a'.repeat(16), sequence: 1, topics: ['catalog'] })).toBe(false);
    expect(isRealtimeInvalidationEnvelope({ version: 1, streamId: 'a'.repeat(16), sequence: 0, topics: ['catalog'] })).toBe(false);
    expect(isRealtimeInvalidationEnvelope({ version: 1, streamId: 'a'.repeat(16), sequence: 1, topics: ['catalog', 'catalog'] })).toBe(false);
    expect(isRealtimeInvalidationEnvelope({ version: 1, streamId: 'a'.repeat(16), sequence: 1, topics: ['warehouse-code'] })).toBe(false);
  });
});
