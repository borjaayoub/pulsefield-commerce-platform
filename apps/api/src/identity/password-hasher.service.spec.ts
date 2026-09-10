import { PasswordHasher } from './password-hasher.service';

describe('PasswordHasher', () => {
  const passwordHasher = new PasswordHasher();

  it('creates an Argon2id encoded hash', async () => {
    // Arrange
    const plainPassword = 'example-password';

    // Act
    const hash = await passwordHasher.hash(plainPassword);

    // Assert
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
  });

  it('creates different hashes for the same password', async () => {
    // Arrange
    const plainPassword = 'example-password';

    // Act
    const firstHash = await passwordHasher.hash(plainPassword);
    const secondHash = await passwordHasher.hash(plainPassword);

    // Assert
    expect(firstHash).not.toBe(secondHash);
  });

  it('verifies the correct password', async () => {
    // Arrange
    const plainPassword = 'example-password';
    const storedHash = await passwordHasher.hash(plainPassword);

    // Act
    const valid = await passwordHasher.verify(plainPassword, storedHash);

    // Assert
    expect(valid).toBe(true);
  });

  it('verifies the incorrect password', async () => {
    // Arrange
    const plainPassword = 'example-password';
    const incorrectPassword = 'different-password';
    const storedHash = await passwordHasher.hash(plainPassword);

    // Act
    const valid = await passwordHasher.verify(incorrectPassword, storedHash);

    // Assert
    expect(valid).toBe(false);
  });

  it('treats canonically equivalent Unicode passwords consistently', async () => {
    // Arrange
    const composedPassword = 'Café password phrase';
    const decomposedPassword = 'Cafe\u0301 password phrase';
    const storedHash = await passwordHasher.hash(composedPassword);

    // Act
    const valid = await passwordHasher.verify(decomposedPassword, storedHash);

    // Assert
    expect(valid).toBe(true);
  });

  it('rejects a malformed stored hash', async () => {
    // Arrange
    const plainPassword = 'example-password';
    const malformedHash = 'not-an-argon2-hash';

    // Act and Assert
    await expect(passwordHasher.verify(plainPassword, malformedHash)).rejects.toThrow();
  });
});
