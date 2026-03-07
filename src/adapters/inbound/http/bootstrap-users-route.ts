import type { FastifyInstance } from 'fastify';
import type { BootstrapUserUseCase } from '../../../application/profile/use-cases.js';

export interface KeycloakWebhookBootstrapConfig {
  webhookSecret?: string;
  webhookBasicUser?: string;
  webhookBasicPass?: string;
  allowedWebhookClientIds: Set<string>;
}

interface BootstrapRouteDeps {
  bootstrapUser: BootstrapUserUseCase;
}

type BootstrapBody = {
  sub?: string;
  userId?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  given_name?: string;
  family_name?: string;
  clientId?: string;
  details?: {
    username?: string;
    identity_provider_identity?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    given_name?: string;
    family_name?: string;
  };
};

function hasValidBasicAuth(
  authHeader: string | undefined,
  expectedUser: string | undefined,
  expectedPass: string | undefined
): boolean {
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
      expectedUser &&
      expectedPass &&
      user === expectedUser &&
      pass === expectedPass
  );
}

export async function registerBootstrapUsersRoute(
  app: FastifyInstance,
  deps: BootstrapRouteDeps,
  config: KeycloakWebhookBootstrapConfig
) {
  app.post<{ Body: BootstrapBody }>(
    '/internal/users/bootstrap',
    async (request, reply) => {
      if (!config.webhookSecret && !(config.webhookBasicUser && config.webhookBasicPass)) {
        return reply.status(503).send({ error: 'Webhook not configured' });
      }

      const rawSecret =
        request.headers['x-keycloak-webhook-secret'] ??
        request.headers['x-internal-token'];
      const candidateSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
      const authHeader = request.headers.authorization;

      const hasSharedSecret = Boolean(
        config.webhookSecret && candidateSecret === config.webhookSecret
      );
      const hasBasicAuth = hasValidBasicAuth(
        authHeader,
        config.webhookBasicUser,
        config.webhookBasicPass
      );

      if (!hasSharedSecret && !hasBasicAuth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const {
        sub: subFromBody,
        userId,
        preferred_username,
        email,
        name,
        first_name,
        last_name,
        given_name,
        family_name,
        clientId,
        details
      } = request.body ?? {};

      const sub = subFromBody ?? userId;
      if (!sub) {
        return reply.status(400).send({ error: 'Missing sub' });
      }

      if (
        config.allowedWebhookClientIds.size > 0 &&
        (!clientId || !config.allowedWebhookClientIds.has(clientId))
      ) {
        return reply.status(403).send({ error: 'Unauthorized client' });
      }

      const inferredEmail =
        email ?? details?.email ?? details?.identity_provider_identity ?? null;
      const inferredPreferred =
        preferred_username ??
        details?.identity_provider_identity ??
        details?.username ??
        null;
      const preferredGiven =
        given_name ??
        first_name ??
        details?.given_name ??
        details?.first_name ??
        null;
      const preferredFamily =
        family_name ??
        last_name ??
        details?.family_name ??
        details?.last_name ??
        null;
      const inferredNameFromParts =
        [preferredGiven, preferredFamily].filter(Boolean).join(' ').trim() || null;
      const inferredName = name ?? inferredNameFromParts ?? inferredPreferred ?? inferredEmail ?? null;

      return deps.bootstrapUser.execute({
        id: sub,
        preferredHandle: inferredPreferred ?? inferredEmail,
        displayName: inferredName,
        bio: null,
        avatarKey: null
      });
    }
  );
}
