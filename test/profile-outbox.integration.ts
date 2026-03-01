import assert from 'node:assert/strict';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';
import {
  createKafkaIntegrationEventPublisher,
  disconnectProducer
} from '@mereb/shared-packages';
import {
  createTemporarySchemaName,
  dropSchema,
  provisionSchema,
  runPrismaMigrateDeploy,
  withSchema
} from '@mereb/shared-packages/testing/db';
import {
  ensureKafkaTopicExists,
  waitForKafkaTopicMessages
} from '@mereb/shared-packages/testing/kafka';
import { PrismaClient } from '../generated/client/index.js';
import {
  PrismaFollowRepository,
  PrismaProfileOutboxEventPublisher,
  PrismaProfileOutboxRelayStore,
  PrismaProfileTransactionRunner,
  PrismaUserRepository
} from '../src/adapters/outbound/prisma/profile-prisma-repositories.js';
import { createProfileApplicationModule } from '../src/application/profile/use-cases.js';
import { flushProfileOutboxOnce } from '../src/bootstrap/outbox-relay.js';
import { PROFILE_EVENT_TOPICS } from '../src/contracts/profile-events.js';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseName = 'mereb-db';
const roleName = 'svc_profile_rw';

type StartedContainer = Awaited<ReturnType<GenericContainer['start']>>;

let postgresContainer: StartedContainer | null = null;
let redpandaContainer: StartedContainer | null = null;

async function waitForDatabaseReady(timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: getAdminDatabaseUrl()
        }
      }
    });

    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      await prisma.$disconnect();
      return;
    } catch {
      await prisma.$disconnect().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error('Postgres test container did not become query-ready in time');
}

beforeAll(async () => {
  postgresContainer = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_DB: databaseName,
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres'
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();
  await waitForDatabaseReady();

  redpandaContainer = await new GenericContainer('redpandadata/redpanda:v24.1.11')
    .withCommand([
      'redpanda',
      'start',
      '--overprovisioned',
      '--smp',
      '1',
      '--memory',
      '1G',
      '--reserve-memory',
      '0M',
      '--node-id',
      '0',
      '--check=false'
    ])
    .withExposedPorts(9092)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
}, 180_000);

afterAll(async () => {
  await disconnectProducer().catch(() => undefined);
  if (redpandaContainer) {
    await redpandaContainer.stop();
  }
  if (postgresContainer) {
    await postgresContainer.stop();
  }
}, 180_000);

function getAdminDatabaseUrl(): string {
  if (!postgresContainer) {
    throw new Error('Postgres container not started');
  }

  return `postgresql://postgres:postgres@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/${databaseName}?schema=public`;
}

function getBaseServiceDatabaseUrl(): string {
  if (!postgresContainer) {
    throw new Error('Postgres container not started');
  }

  return `postgresql://${roleName}:${roleName}@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/${databaseName}?schema=svc_profile`;
}

function getKafkaConfig(): Parameters<typeof createKafkaIntegrationEventPublisher>[0] {
  if (!redpandaContainer) {
    throw new Error('Redpanda container not started');
  }

  const host = redpandaContainer.getHost();
  const port = redpandaContainer.getMappedPort(9092);

  return {
    clientId: 'svc-profile-it',
    brokers: [`${host}:${port}`],
    socketFactory: ({ onConnect }) => net.connect({ host, port }, onConnect)
  };
}

async function ensureServiceRole(admin: PrismaClient): Promise<void> {
  await admin.$executeRawUnsafe(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
        CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}';
      ELSE
        ALTER ROLE ${roleName} WITH LOGIN PASSWORD '${roleName}';
      END IF;
    END
    $role$;
  `);
  await admin.$executeRawUnsafe(
    `GRANT CONNECT ON DATABASE "${databaseName}" TO ${roleName}`
  );
}

test(
  'bootstrapUser writes a profile outbox event and publishes it to Kafka',
  { timeout: 180_000 },
  async () => {
    const schema = createTemporarySchemaName('svc_profile_it');
    const databaseUrl = withSchema(getBaseServiceDatabaseUrl(), schema);
    const kafkaConfig = getKafkaConfig();
    const admin = new PrismaClient({
      datasources: {
        db: {
          url: getAdminDatabaseUrl()
        }
      }
    });
    let prisma: PrismaClient | null = null;

    try {
      await ensureServiceRole(admin);
      await provisionSchema(admin, { schema, ownerRole: roleName });
      await runPrismaMigrateDeploy({
        cwd: serviceDir,
        databaseUrl
      });

      prisma = new PrismaClient({
        datasources: {
          db: {
            url: databaseUrl
          }
        }
      });

      const users = new PrismaUserRepository(prisma);
      const follows = new PrismaFollowRepository(prisma);
      const profile = createProfileApplicationModule({
        users,
        follows,
        profileRead: users,
        eventPublisher: new PrismaProfileOutboxEventPublisher(prisma),
        mediaUrlSigner: {
          signMediaUrl(key: string) {
            return `https://cdn.test/${key}`;
          }
        },
        eventProducerName: 'svc-profile',
        transactionRunner: new PrismaProfileTransactionRunner(prisma)
      });

      const result = await profile.commands.bootstrapUser.execute({
        id: 'user-1',
        preferredHandle: 'user_1',
        displayName: 'User One',
        bio: null,
        avatarKey: null
      });

      assert.deepEqual(result, {
        created: true,
        userId: 'user-1',
        handle: 'user_1'
      });

      const storedUser = await prisma.user.findUnique({
        where: { id: 'user-1' }
      });
      assert.equal(storedUser?.handle, 'user_1');

      const store = new PrismaProfileOutboxRelayStore(prisma);
      const pendingBefore = await store.listDue(10);
      assert.equal(pendingBefore.length, 1);
      assert.equal(pendingBefore[0]?.topic, PROFILE_EVENT_TOPICS.userBootstrapped);
      assert.deepEqual(pendingBefore[0]?.envelope.data, {
        user_id: 'user-1',
        handle: 'user_1'
      });

      await ensureKafkaTopicExists({
        ...kafkaConfig,
        topic: PROFILE_EVENT_TOPICS.userBootstrapped
      });

      await flushProfileOutboxOnce({
        limit: 10,
        store,
        publisher: createKafkaIntegrationEventPublisher(kafkaConfig)
      });

      const messageCount = await waitForKafkaTopicMessages({
        ...kafkaConfig,
        topic: PROFILE_EVENT_TOPICS.userBootstrapped
      });
      assert.equal(messageCount, 1);

      const row = await prisma.outboxEvent.findUnique({
        where: { id: pendingBefore[0]?.id ?? '' }
      });
      assert.equal(row?.status, 'PUBLISHED');
    } finally {
      await disconnectProducer().catch(() => undefined);
      if (prisma) {
        await prisma.$disconnect();
      }
      await dropSchema(admin, schema);
      await admin.$disconnect();
    }
  }
);
