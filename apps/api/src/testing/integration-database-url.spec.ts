import { resolveIntegrationDatabaseUrl } from './integration-database-url';

describe('resolveIntegrationDatabaseUrl', () => {
  const developmentUrl =
    'postgresql://pulsefield:local-password@localhost:5432/pulsefield?schema=public';

  it('derives a dedicated test database while preserving connection options', () => {
    expect(resolveIntegrationDatabaseUrl(developmentUrl)).toBe(
      'postgresql://pulsefield:local-password@localhost:5432/pulsefield_test?schema=public',
    );
  });

  it('accepts an explicit local database whose name ends in _test', () => {
    const explicitUrl =
      'postgresql://pulsefield:local-password@127.0.0.1:5432/custom_test?schema=public';

    expect(resolveIntegrationDatabaseUrl(developmentUrl, explicitUrl)).toBe(explicitUrl);
  });

  it('rejects a remote test database', () => {
    expect(() =>
      resolveIntegrationDatabaseUrl(
        developmentUrl,
        'postgresql://pulsefield:password@database.example.com:5432/pulsefield_test',
      ),
    ).toThrow('TEST_DATABASE_URL must point to a local PostgreSQL host.');
  });

  it('rejects the development database as the test target', () => {
    const developmentTestUrl =
      'postgresql://pulsefield:local-password@localhost:5432/pulsefield_test';

    expect(() => resolveIntegrationDatabaseUrl(developmentTestUrl, developmentTestUrl)).toThrow(
      'Integration tests must not use the development database.',
    );
  });

  it('rejects a test database without the _test suffix', () => {
    expect(() =>
      resolveIntegrationDatabaseUrl(
        developmentUrl,
        'postgresql://pulsefield:local-password@localhost:5432/another_database',
      ),
    ).toThrow('The integration database name must end with "_test".');
  });

  it('rejects a database name that cannot be safely used as an identifier', () => {
    expect(() =>
      resolveIntegrationDatabaseUrl(
        developmentUrl,
        'postgresql://pulsefield:local-password@localhost:5432/unsafe-name_test',
      ),
    ).toThrow(
      'TEST_DATABASE_URL must include one database name using only letters, numbers, and underscores.',
    );
  });
});
