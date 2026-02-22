import Fastify, { type FastifyInstance } from 'fastify';
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
  createFastifyLoggerOptions,
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

const typeDefsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.graphql'
);
const typeDefs = readFileSync(typeDefsPath, 'utf8');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({logger: createFastifyLoggerOptions('svc-profile')});

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(underPressure);

  const issuer = getEnv('OIDC_ISSUER');
  const audience = process.env.OIDC_AUDIENCE;
  const webhookSecret = process.env.KEYCLOAK_WEBHOOK_SECRET;
  const webhookBasicUser = process.env.KEYCLOAK_WEBHOOK_BASIC_USER;
  const webhookBasicPass = process.env.KEYCLOAK_WEBHOOK_BASIC_PASS;
  const allowedWebhookClientIds =
    process.env.KEYCLOAK_WEBHOOK_CLIENT_IDS
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const allowedWebhookClientIdSet = new Set(allowedWebhookClientIds);

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
      userId?: string;
      preferred_username?: string;
      email?: string;
      name?: string;
      clientId?: string;
      details?: {
        username?: string;
        identity_provider_identity?: string;
        email?: string;
      };
    };
  }>('/internal/users/bootstrap', async (request, reply) => {
    if (!webhookSecret && !(webhookBasicUser && webhookBasicPass)) {
      return reply.status(503).send({ error: 'Webhook not configured' });
    }

    const rawSecret = request.headers['x-keycloak-webhook-secret'] ?? request.headers['x-internal-token'];
    const candidateSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
    const authHeader = request.headers.authorization;

    const hasSharedSecret = Boolean(webhookSecret && candidateSecret === webhookSecret);
    const hasBasicAuth = (() => {
      if (!authHeader?.startsWith('Basic ')) {
        return false;
      }
      const encoded = authHeader.slice('Basic '.length);
      let decoded: string;
      try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
      } catch {
        return false;
      }
      const [user, pass] = decoded.split(':');
      return Boolean(
        user &&
          pass &&
          webhookBasicUser &&
          webhookBasicPass &&
          user === webhookBasicUser &&
          pass === webhookBasicPass
      );
    })();

    if (!hasSharedSecret && !hasBasicAuth) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { sub: subFromBody, userId, preferred_username, email, name, clientId, details } =
      request.body ?? {};
    const sub = subFromBody ?? userId;
    if (!sub) {
      return reply.status(400).send({ error: 'Missing sub' });
    }

    if (allowedWebhookClientIdSet.size > 0 && (!clientId || !allowedWebhookClientIdSet.has(clientId))) {
      return reply.status(403).send({ error: 'Unauthorized client' });
    }

    const inferredEmail = email ?? details?.email ?? details?.identity_provider_identity ?? null;
    const inferredPreferred =
      preferred_username ?? details?.identity_provider_identity ?? details?.username ?? null;
    const inferredName = name ?? inferredPreferred ?? inferredEmail ?? null;

    const existing = await prisma.user.findUnique({ where: { id: sub } });
    if (existing) {
      return { created: false, userId: existing.id };
    }

    const preferredHandle = inferredPreferred ?? inferredEmail;
    const displayName = inferredName;
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
