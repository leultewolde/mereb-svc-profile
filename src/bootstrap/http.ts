import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync
} from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import type { FastifyCorsOptions, FastifyCorsOptionsDelegate } from '@fastify/cors';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import rateLimit from '@fastify/rate-limit';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import mercurius from 'mercurius';
import type { MercuriusOptions } from 'mercurius';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFastifyLoggerOptions,
  extractJwtRoles,
  getEnv,
  loadEnv,
  parseAuthHeader,
  verifyJwt
} from '@mereb/shared-packages';
import type { GraphQLContext, IdentityHints } from '../context.js';
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

type RequestAuthState = {
  userId?: string;
  roles?: string[];
  identityHints?: IdentityHints;
};

const helmetPlugin = helmet as unknown as FastifyPluginAsync;
const corsPlugin = cors as unknown as FastifyPluginAsync<
  FastifyCorsOptions | FastifyCorsOptionsDelegate
>;
const sensiblePlugin = sensible as unknown as FastifyPluginAsync;
const rateLimitPlugin = rateLimit as unknown as FastifyPluginAsync<RateLimitPluginOptions>;
const underPressurePlugin = underPressure as unknown as FastifyPluginAsync;
const mercuriusPlugin = mercurius as unknown as FastifyPluginAsync<
  MercuriusOptions & { federationMetadata?: boolean }
>;

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

function extractIdentityHints(payload: JwtIdentityPayload): IdentityHints | undefined {
  const hints: IdentityHints = {
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

  await app.register(helmetPlugin);
  await app.register(corsPlugin, { origin: true, credentials: true });
  await app.register(sensiblePlugin);
  await app.register(rateLimitPlugin, { max: 1000, timeWindow: '1 minute' });
  await app.register(underPressurePlugin);

  const issuer = getEnv('OIDC_ISSUER');
  const audience = process.env.OIDC_AUDIENCE;

  app.addHook('onRequest', async (request) => {
    const authenticatedRequest = request as typeof request & RequestAuthState;
    const token = parseAuthHeader(request.headers);
    if (!token) {
      authenticatedRequest.userId = undefined;
      authenticatedRequest.roles = [];
      authenticatedRequest.identityHints = undefined;
      return;
    }

    try {
      const payload = (await verifyJwt(token, { issuer, audience })) as JwtIdentityPayload;
      authenticatedRequest.userId = payload.sub;
      authenticatedRequest.roles = extractJwtRoles(payload);
      authenticatedRequest.identityHints = extractIdentityHints(payload);
    } catch (error) {
      request.log.warn({ err: error }, 'JWT verification failed');
      authenticatedRequest.userId = undefined;
      authenticatedRequest.roles = [];
      authenticatedRequest.identityHints = undefined;
    }
  });

  const schema = makeExecutableSchema<GraphQLContext>({
    typeDefs,
    resolvers: createResolvers(container.profile)
  });

  const mercuriusOptions: MercuriusOptions & { federationMetadata?: boolean } = {
    schema,
    graphiql: process.env.NODE_ENV !== 'production',
    federationMetadata: true,
    context: (request): GraphQLContext => {
      const authenticatedRequest = request as typeof request & RequestAuthState;
      return {
        userId: authenticatedRequest.userId,
        roles: authenticatedRequest.roles ?? [],
        identity: authenticatedRequest.identityHints
      };
    }
  };

  await app.register(mercuriusPlugin, mercuriusOptions);

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
