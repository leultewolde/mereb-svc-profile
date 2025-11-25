import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import rateLimit from '@fastify/rate-limit';
import mercurius from 'mercurius';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  getEnv,
  loadEnv,
  parseAuthHeader,
  verifyJwt
} from '@mereb/shared-packages';
import { createResolvers } from './resolvers.js';
import type { GraphQLContext } from './context.js';
import { createUserWithFallback } from './user.js';
import { prisma } from './prisma.js';

loadEnv();

const logger = createLogger('svc-profile');

const typeDefsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.graphql'
);
const typeDefs = readFileSync(typeDefsPath, 'utf8');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: logger as FastifyBaseLogger });

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(underPressure);

  const issuer = getEnv('OIDC_ISSUER');
  const audience = process.env.OIDC_AUDIENCE;
  const webhookSecret = process.env.KEYCLOAK_WEBHOOK_SECRET;

  app.addHook('onRequest', async (request) => {
    const token = parseAuthHeader(request.headers);
    if (!token) {
      request.userId = undefined;
      return;
    }

    try {
      const payload = await verifyJwt(token, { issuer, audience });
      request.userId = payload.sub;
    } catch (error) {
      request.log.warn({ err: error }, 'JWT verification failed');
      request.userId = undefined;
    }
  });

  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers()
  });

  await app.register(mercurius, {
    schema,
    graphiql: process.env.NODE_ENV !== 'production',
    federationMetadata: true,
    context: (request): GraphQLContext => ({ userId: request.userId })
  });

  app.post<{
    Body: {
      sub?: string;
      preferred_username?: string;
      email?: string;
      name?: string;
    };
  }>('/internal/users/bootstrap', async (request, reply) => {
    if (!webhookSecret) {
      return reply.status(503).send({ error: 'Webhook not configured' });
    }

    const rawSecret = request.headers['x-keycloak-webhook-secret'] ?? request.headers['x-internal-token'];
    const candidateSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
    if (!candidateSecret || candidateSecret !== webhookSecret) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { sub, preferred_username, email, name } = request.body ?? {};
    if (!sub) {
      return reply.status(400).send({ error: 'Missing sub' });
    }

    const existing = await prisma.user.findUnique({ where: { id: sub } });
    if (existing) {
      return { created: false, userId: existing.id };
    }

    const preferredHandle = preferred_username ?? email ?? null;
    const displayName = name ?? preferred_username ?? email ?? null;
    const created = await createUserWithFallback({
      id: sub,
      preferredHandle,
      displayName,
      bio: null,
      avatarKey: null
    });

    return { created: true, userId: created.id, handle: created.handle };
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
