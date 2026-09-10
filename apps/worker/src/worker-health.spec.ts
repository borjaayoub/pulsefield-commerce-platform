import { workerHealthResponse } from './worker-health';

describe('worker health response', () => {
  it('is ready only when queue and local SMTP are ready', () => {
    expect(workerHealthResponse({ queue: true, smtp: true })).toMatchObject({
      statusCode: 200,
      body: { status: 'ok', dependencies: { queue: 'ready', smtp: 'ready' } },
    });
  });

  it('reports degraded dependency names without connection details', () => {
    const health = workerHealthResponse({ queue: false, smtp: true });

    expect(health).toMatchObject({
      statusCode: 503,
      body: { status: 'degraded', dependencies: { queue: 'unavailable', smtp: 'ready' } },
    });
    expect(JSON.stringify(health)).not.toContain('redis://');
  });
});
