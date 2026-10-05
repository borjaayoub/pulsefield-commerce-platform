// Test-process preload: emit only allowlisted error classifications over IPC.
// Never emit exception messages, stacks, headers, payloads or credentials.
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api/dist/src');
const require = createRequire(import.meta.url);
const target = new URL(process.env.DATABASE_URL);
assert.match(target.pathname, /^\/slice56_processes_[a-f0-9]{32}_test$/u);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.equal(process.env.LOCAL_DEVELOPMENT_PROFILE, 'zero-cost-local');
const { HttpProblemDetailsFilter } = require(
  path.join(base, 'http/http-problem-details.filter.js'),
);
const { isRetryableTransactionError } = require(path.join(base, 'checkout/checkout.service.js'));
const original = HttpProblemDetailsFilter.prototype.catch;
HttpProblemDetailsFilter.prototype.catch = function diagnose(exception, host) {
  if (process.send) {
    const code = ['P2034', 'P2028', 'P2002', '40001', '40P01'].includes(exception?.code)
      ? exception.code
      : 'other';
    process.send({
      kind: 'phase5-error-classification',
      code,
      retryable: isRetryableTransactionError(exception),
    });
  }
  return original.call(this, exception, host);
};
