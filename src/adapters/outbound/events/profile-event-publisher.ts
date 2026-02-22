import {
  buildKafkaConfigFromEnv,
  createLogger,
  getProducer,
  type IntegrationEventEnvelope
} from '@mereb/shared-packages';
import type { EventPublisherPort } from '../../../application/profile/ports.js';
import type { ProfileIntegrationEventRequest } from '../../../contracts/profile-events.js';

type KafkaConfig = NonNullable<ReturnType<typeof buildKafkaConfigFromEnv>>;

const logger = createLogger('svc-profile-events');

export class ProfileEventPublisherAdapter implements EventPublisherPort {
  constructor(
    private readonly config: KafkaConfig | null,
    private readonly enabled: boolean
  ) {}

  async publish<TData>(
    request: ProfileIntegrationEventRequest<TData>,
    envelope: IntegrationEventEnvelope<TData>
  ): Promise<void> {
    if (!this.enabled || !this.config) {
      return;
    }

    try {
      const producer = await getProducer(this.config);
      await producer.send({
        topic: request.topic,
        messages: [
          {
            key: request.key,
            value: JSON.stringify(envelope)
          }
        ]
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          topic: request.topic,
          eventType: request.eventType,
          key: request.key
        },
        'Failed to publish profile integration event'
      );
    }
  }
}

function isEventsEnabled(): boolean {
  return (process.env.PROFILE_EVENTS_ENABLED ?? 'false') === 'true';
}

export function createProfileEventPublisherAdapter(): ProfileEventPublisherAdapter {
  const enabled = isEventsEnabled();
  if (!enabled) {
    return new ProfileEventPublisherAdapter(null, false);
  }

  const config = buildKafkaConfigFromEnv({ clientId: 'svc-profile' });
  if (!config) {
    logger.warn('PROFILE_EVENTS_ENABLED=true but Kafka config is missing; using no-op event publisher');
    return new ProfileEventPublisherAdapter(null, false);
  }

  return new ProfileEventPublisherAdapter(config, true);
}
