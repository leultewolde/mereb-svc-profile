import { test } from 'vitest';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerBootstrapUsersRoute } from '../src/adapters/inbound/http/bootstrap-users-route.js';

test('bootstrap route rejects unauthorized requests', async () => {
  const app = Fastify();
  await registerBootstrapUsersRoute(
    app,
    {
      bootstrapUser: {
        async execute() {
          throw new Error('should not be called');
        }
      }
    },
    {
      webhookSecret: 'secret',
      webhookBasicUser: undefined,
      webhookBasicPass: undefined,
      allowedWebhookClientIds: new Set()
    }
  );

  const response = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    payload: { sub: 'u1' }
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

test('bootstrap route calls use case on valid shared secret', async () => {
  const app = Fastify();
  let called = false;

  await registerBootstrapUsersRoute(
    app,
    {
      bootstrapUser: {
        async execute(input) {
          called = true;
          assert.equal(input.id, 'user-1');
          return { created: true, userId: 'user-1', handle: 'user_1' };
        }
      }
    },
    {
      webhookSecret: 'secret',
      webhookBasicUser: undefined,
      webhookBasicPass: undefined,
      allowedWebhookClientIds: new Set(['frontend-app'])
    }
  );

  const response = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    headers: {
      'x-keycloak-webhook-secret': 'secret'
    },
    payload: {
      sub: 'user-1',
      clientId: 'frontend-app',
      preferred_username: 'User One',
      email: 'one@example.com'
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(called, true);
  assert.deepEqual(response.json(), {
    created: true,
    userId: 'user-1',
    handle: 'user_1'
  });

  await app.close();
});

test('bootstrap route returns 503 when webhook auth is not configured', async () => {
  const app = Fastify();

  await registerBootstrapUsersRoute(
    app,
    {
      bootstrapUser: {
        async execute() {
          throw new Error('should not be called');
        }
      }
    },
    {
      webhookSecret: undefined,
      webhookBasicUser: undefined,
      webhookBasicPass: undefined,
      allowedWebhookClientIds: new Set()
    }
  );

  const response = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    payload: { sub: 'u1' }
  });

  assert.equal(response.statusCode, 503);
  await app.close();
});

test('bootstrap route validates client id and missing subject', async () => {
  const app = Fastify();

  await registerBootstrapUsersRoute(
    app,
    {
      bootstrapUser: {
        async execute() {
          throw new Error('should not be called');
        }
      }
    },
    {
      webhookSecret: 'secret',
      webhookBasicUser: undefined,
      webhookBasicPass: undefined,
      allowedWebhookClientIds: new Set(['frontend-app'])
    }
  );

  const missingSub = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    headers: {
      'x-keycloak-webhook-secret': 'secret'
    },
    payload: {}
  });
  assert.equal(missingSub.statusCode, 400);

  const unauthorizedClient = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    headers: {
      'x-keycloak-webhook-secret': 'secret'
    },
    payload: {
      sub: 'user-1',
      clientId: 'unknown-app'
    }
  });
  assert.equal(unauthorizedClient.statusCode, 403);

  await app.close();
});

test('bootstrap route accepts valid basic auth and infers handle fields from details', async () => {
  const app = Fastify();
  let receivedInput: Record<string, unknown> | null = null;

  await registerBootstrapUsersRoute(
    app,
    {
      bootstrapUser: {
        async execute(input) {
          receivedInput = input as Record<string, unknown>;
          return { created: true, userId: input.id, handle: String(input.preferredHandle) };
        }
      }
    },
    {
      webhookSecret: undefined,
      webhookBasicUser: 'webhook-user',
      webhookBasicPass: 'webhook-pass',
      allowedWebhookClientIds: new Set()
    }
  );

  const response = await app.inject({
    method: 'POST',
    url: '/internal/users/bootstrap',
    headers: {
      authorization: `Basic ${Buffer.from('webhook-user:webhook-pass').toString('base64')}`
    },
    payload: {
      userId: 'user-2',
      details: {
        username: 'user-two',
        identity_provider_identity: 'user.two@example.com'
      }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedInput, {
    id: 'user-2',
    preferredHandle: 'user.two@example.com',
    displayName: 'user.two@example.com',
    bio: null,
    avatarKey: null
  });
  assert.deepEqual(response.json(), {
    created: true,
    userId: 'user-2',
    handle: 'user.two@example.com'
  });

  await app.close();
});
