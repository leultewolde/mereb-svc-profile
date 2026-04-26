import {
  buildKafkaConfigFromEnv,
  createLogger,
  initDefaultTelemetry,
  loadEnv,
  waitForShutdown
} from '@mereb/shared-packages';
import { startProfileOutboxRelay } from './bootstrap/outbox-relay.js';

const logger = createLogger('svc-profile-outbox-worker');

loadEnv();
initDefaultTelemetry('svc-profile-outbox-relay');

if ((process.env.PROFILE_EVENTS_ENABLED ?? 'false') !== 'true') {
  logger.error('PROFILE_EVENTS_ENABLED must be true for outbox relay worker');
  process.exit(1);
}

if ((process.env.PROFILE_OUTBOX_RELAY_ENABLED ?? 'true') !== 'true') {
  logger.error('PROFILE_OUTBOX_RELAY_ENABLED=false; dedicated outbox relay worker will not start');
  process.exit(1);
}

if (!buildKafkaConfigFromEnv({ clientId: 'svc-profile-outbox-relay' })) {
  logger.error('Kafka config missing; cannot start profile outbox relay worker');
  process.exit(1);
}

try {
  const stop = startProfileOutboxRelay({ unrefTimer: false });
  logger.info('Profile outbox relay worker started');
  await waitForShutdown(stop, { logger, name: 'profile outbox relay worker' });
} catch (error) {
  logger.error({ err: error }, 'Failed to start profile outbox relay worker');
  process.exit(1);
}

