import 'dotenv/config';
import { validateLocalProfile } from '../packages/foundation/src/local-profile';

try {
  const profile = validateLocalProfile(process.env);
  process.stdout.write(
    `Local profile validated: ${profile.LOCAL_DEVELOPMENT_PROFILE}; payment provider: ${profile.PAYMENT_PROVIDER}.\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Environment validation failed.'}\n`);
  process.exitCode = 1;
}
