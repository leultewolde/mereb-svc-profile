import {
  buildKafkaConfigFromEnv,
  createKafkaIntegrationEventPublisher,
  createLogger,
  type IntegrationEventEnvelope
} from '@mereb/shared-packages';
import { PrismaProfileOutboxRelayStore } from '../adapters/outbound/prisma/profile-prisma-repositories.js';

const logger = createLogger('svc-profile-outbox-relay');

function isRelayEnabled(): boolean {
  if ((process.env.PROFILE_EVENTS_ENABLED ?? 'false') !== 'true') {
    return false;
  }
  return (process.env.PROFILE_OUTBOX_RELAY_ENABLED ?? 'true') === 'true';
}

function getRelayIntervalMs(): number {
  const value = Number(process.env.PROFILE_OUTBOX_RELAY_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(value) || value < 250) {
    return 5000;
  }
  return Math.floor(value);
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1), 6);
  return Math.min(60_000, 1000 * (2 ** exponent));
}

async function flushOnce(limit = 50): Promise<void> {
  const config = buildKafkaConfigFromEnv({ clientId: 'svc-profile-outbox-relay' });
  if (!config) {
    logger.warn('Profile outbox relay enabled but Kafka config is missing; skipping flush');
    return;
  }

  const publisher = createKafkaIntegrationEventPublisher(config);
  const store = new PrismaProfileOutboxRelayStore();
  const due = await store.listDue(limit);

  if (due.length === 0) {
    return;
  }

  for (const event of due) {
    const claimed = await store.claim(event.id);
    if (!claimed) {
      continue;
    }

    try {
      await publisher.publish(
        event.topic,
        event.envelope as IntegrationEventEnvelope<unknown>,
        { key: event.eventKey ?? undefined }
      );
      await store.markPublished(event.id);
    } catch (error) {
      await store.markFailed(
        event.id,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        new Date(Date.now() + retryDelayMs(event.attempts + 1))
      );
      logger.warn(
        {
          err: error,
          outboxId: event.id,
          topic: event.topic,
          eventType: event.eventType
        },
        'Failed to publish profile outbox event'
      );
    }
  }
}

export function startProfileOutboxRelay(): () => void {
  if (!isRelayEnabled()) {
    return () => {};
  }

  const intervalMs = getRelayIntervalMs();
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await flushOnce();
    } catch (error) {
      logger.error({ err: error }, 'Unexpected error in profile outbox relay');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  logger.info({ intervalMs }, 'Profile outbox relay started');

  return () => clearInterval(timer);
}

