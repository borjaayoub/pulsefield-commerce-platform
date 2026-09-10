import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { InvalidAuditQueryError } from './audit.errors';

describe('audit cursor', () => {
  const cursor = {
    occurredAt: new Date('2026-09-03T15:00:00.000Z'),
    id: 'f62d69e7-0c86-4df8-b592-577815cb8461',
  };

  it('round-trips the exact keyset position', () => {
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it.each(['not-a-cursor-value', Buffer.from('{}').toString('base64url'), '%%%invalid%%%'])(
    'rejects malformed cursor %s',
    (value) => expect(() => decodeAuditCursor(value)).toThrow(InvalidAuditQueryError),
  );
});
