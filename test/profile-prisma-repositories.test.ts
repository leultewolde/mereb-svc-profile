import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { PrismaUserRepository } from '../src/adapters/outbound/prisma/profile-prisma-repositories.js';

afterEach(() => {
  vi.restoreAllMocks();
});

test('findOrCreateWithFallback retries handle allocation without aborting the transaction', async () => {
  const findUnique = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null);
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        id: 'viewer-1',
        handle: 'admin_123abc',
        displayName: 'Admin User',
        bio: null,
        avatarKey: null,
        createdAt: new Date('2026-03-14T00:00:00.000Z')
      }
    ]);

  vi.spyOn(Math, 'random').mockReturnValue(0.123456);

  const repository = new PrismaUserRepository({
    user: {
      findUnique
    },
    $queryRaw: queryRaw
  } as never);

  const user = await repository.findOrCreateWithFallback({
    id: 'viewer-1',
    preferredHandle: 'admin',
    displayName: 'Admin User'
  });

  assert.equal(user.id, 'viewer-1');
  assert.equal(user.handle, 'admin_123abc');
  assert.equal(findUnique.mock.calls.length, 2);
  assert.equal(queryRaw.mock.calls.length, 2);
});
