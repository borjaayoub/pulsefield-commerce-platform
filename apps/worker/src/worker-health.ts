export interface WorkerDependencyState {
  queue: boolean;
  smtp: boolean;
}

export function workerHealthResponse(dependencies: WorkerDependencyState): {
  statusCode: 200 | 503;
  body: {
    status: 'ok' | 'degraded';
    service: 'pulse-field-worker';
    profile: 'zero-cost-local';
    dependencies: { queue: 'ready' | 'unavailable'; smtp: 'ready' | 'unavailable' };
  };
} {
  const ready = dependencies.queue && dependencies.smtp;
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? 'ok' : 'degraded',
      service: 'pulse-field-worker',
      profile: 'zero-cost-local',
      dependencies: {
        queue: dependencies.queue ? 'ready' : 'unavailable',
        smtp: dependencies.smtp ? 'ready' : 'unavailable',
      },
    },
  };
}
