const localDatabaseHostnames = new Set(['localhost', '127.0.0.1', 'postgres']);

function parsePostgresUrl(value: string, label: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`${label} must use the PostgreSQL protocol.`);
  }

  if (!localDatabaseHostnames.has(url.hostname)) {
    throw new Error(`${label} must point to a local PostgreSQL host.`);
  }

  return url;
}

function databaseName(url: URL, label: string): string {
  const name = decodeURIComponent(url.pathname.slice(1));

  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(
      `${label} must include one database name using only letters, numbers, and underscores.`,
    );
  }

  return name;
}

export function resolveIntegrationDatabaseUrl(
  developmentDatabaseUrl: string,
  explicitTestDatabaseUrl?: string,
): string {
  const developmentUrl = parsePostgresUrl(developmentDatabaseUrl, 'DATABASE_URL');
  const developmentName = databaseName(developmentUrl, 'DATABASE_URL');

  const testUrl = explicitTestDatabaseUrl
    ? parsePostgresUrl(explicitTestDatabaseUrl, 'TEST_DATABASE_URL')
    : new URL(developmentUrl.href);

  if (!explicitTestDatabaseUrl) {
    testUrl.pathname = `/${developmentName}_test`;
  }

  const testName = databaseName(testUrl, 'TEST_DATABASE_URL');

  if (!testName.endsWith('_test')) {
    throw new Error('The integration database name must end with "_test".');
  }

  if (testName === developmentName) {
    throw new Error('Integration tests must not use the development database.');
  }

  return testUrl.href;
}
