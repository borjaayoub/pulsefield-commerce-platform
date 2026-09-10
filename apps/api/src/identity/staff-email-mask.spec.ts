import { maskEmailForStaffView } from './staff-email-mask';

describe('maskEmailForStaffView', () => {
  it.each([
    ['ayoub@example.com', 'a***@e***.com'],
    ['a@shop.example.co.uk', 'a***@s***.e***.c***.uk'],
    ['équipe@exemple.ma', 'é***@e***.ma'],
  ])('masks the mailbox and domain labels for %s', (email, expected) => {
    expect(maskEmailForStaffView(email)).toBe(expected);
  });

  it.each(['missing-at-sign', '@example.com', 'person@localhost', 'person@example..com'])(
    'fully redacts malformed input %s',
    (email) => expect(maskEmailForStaffView(email)).toBe('[REDACTED_EMAIL]'),
  );
});
