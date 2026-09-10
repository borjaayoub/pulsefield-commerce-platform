import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace and lowercases the email', () => {
    // Arrange
    const email = '  User@Example.COM  ';

    // Act
    const normalizedEmail = normalizeEmail(email);

    // Assert
    expect(normalizedEmail).toBe('user@example.com');
  });

  it('preserves meaningful characters in the local part', () => {
    // Arrange
    const email = 'User.Name+shop@Example.COM';

    // Act
    const normalizedEmail = normalizeEmail(email);

    // Assert
    expect(normalizedEmail).toBe('user.name+shop@example.com');
  });

  it('is idempotent', () => {
    // Arrange
    const email = '  User@Example.COM  ';

    // Act
    const normalizedOnce = normalizeEmail(email);
    const normalizedTwice = normalizeEmail(normalizedOnce);

    // Assert
    expect(normalizedTwice).toBe(normalizedOnce);
  });
});
