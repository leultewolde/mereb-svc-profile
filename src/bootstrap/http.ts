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
import type { GraphQLContext } from '../context.js';
import { createContainer } from './container.js';
import { createResolvers } from '../adapters/inbound/graphql/resolvers.js';
import { registerBootstrapUsersRoute } from '../adapters/inbound/http/bootstrap-users-route.js';

loadEnv();

const typeDefsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schema.graphql'
);
const typeDefs = readFileSync(typeDefsPath, 'utf8');

function parseAllowedWebhookClientIds(): Set<string> {
  const clientIds =
    process.env.KEYCLOAK_WEBHOOK_CLIENT_IDS
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];

  return new Set(clientIds);
}

type JwtIdentityPayload = {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

function extractIdentityHints(payload: JwtIdentityPayload) {
  const hints = {
    preferredUsername: payload.preferred_username,
    email: payload.email,
    name: payload.name,
    givenName: payload.given_name,
    familyName: payload.family_name
  };
  if (!Object.values(hints).some(Boolean)) {
    return undefined;
  }
  return hints;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createFastifyLoggerOptions('svc-profile')
  });

  const container = createContainer();

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(underPressure);

  const issuer = getEnv('OIDC_ISSUER');
  const audience = process.env.OIDC_AUDIENCE;

  app.addHook('onRequest', async (request) => {
    const token = parseAuthHeader(request.headers);
    if (!token) {
      request.userId = undefined;
      request.identityHints = undefined;
      return;
    }

    try {
      const payload = (await verifyJwt(token, { issuer, audience })) as JwtIdentityPayload;
      request.userId = payload.sub;
      request.identityHints = extractIdentityHints(payload);
    } catch (error) {
      request.log.warn({ err: error }, 'JWT verification failed');
      request.userId = undefined;
      request.identityHints = undefined;
    }
  });

  const schema = makeExecutableSchema<GraphQLContext>({
    typeDefs,
    resolvers: createResolvers(container.profile)
  });

  await app.register(mercurius, {
    schema,
    graphiql: process.env.NODE_ENV !== 'production',
    federationMetadata: true,
    context: (request): GraphQLContext => ({ userId: request.userId, identity: request.identityHints })
  });

  await registerBootstrapUsersRoute(
    app,
    { bootstrapUser: container.profile.commands.bootstrapUser },
    {
      webhookSecret: process.env.KEYCLOAK_WEBHOOK_SECRET,
      webhookBasicUser: process.env.KEYCLOAK_WEBHOOK_BASIC_USER,
      webhookBasicPass: process.env.KEYCLOAK_WEBHOOK_BASIC_PASS,
      allowedWebhookClientIds: parseAllowedWebhookClientIds()
    }
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
