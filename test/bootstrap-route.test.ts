import test from 'node:test';
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
