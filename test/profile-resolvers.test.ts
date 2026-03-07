import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createResolvers } from '../src/adapters/inbound/graphql/resolvers.js';
import type { ProfileApplicationModule } from '../src/application/profile/use-cases.js';
import {
  AuthenticationRequiredError,
  CannotFollowSelfError,
  CannotUnfollowSelfError,
  InvalidMediaAssetError
} from '../src/domain/profile/errors.js';

function createProfileStub(): ProfileApplicationModule {
  return {
    commands: {
      bootstrapUser: {
        async execute() {
          return { created: true, userId: 'u1', handle: 'user_1' };
        }
      },
      updateProfile: {
        async execute() {
          return {
            id: 'u1',
            handle: 'user_1',
            displayName: 'User One',
            bio: null,
            avatarKey: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z')
          };
        }
      },
      followUser: {
        async execute() {
          return {
            id: 'u2',
            handle: 'user_2',
            displayName: 'User Two',
            bio: null,
            avatarKey: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z')
          };
        }
      },
      unfollowUser: {
        async execute() {
          return {
            id: 'u2',
            handle: 'user_2',
            displayName: 'User Two',
            bio: null,
            avatarKey: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z')
          };
        }
      }
    },
    queries: {
      getMe: { async execute() { return null; } },
      getUserByHandle: { async execute() { return null; } },
      getAdminUserMetrics: { async execute() { return { totalUsers: 0, newUsersToday: 0, newUsersThisWeek: 0 }; } },
      getAdminRecentUsers: { async execute() { return []; } },
      resolveUserReference: { async execute() { return null; } },
      getFollowersCount: { async execute() { return 0; } },
      getFollowingCount: { async execute() { return 0; } },
      getFollowedByViewer: { async execute() { return false; } }
    },
    services: {
      avatarUrlResolver: {
        resolve() {
          return null;
        }
      }
    }
  } as unknown as ProfileApplicationModule;
}

test('updateProfile maps AuthenticationRequiredError to UNAUTHENTICATED', async () => {
  const profile = createProfileStub();
  profile.commands.updateProfile = {
    async execute() {
      throw new AuthenticationRequiredError();
    }
  } as ProfileApplicationModule['commands']['updateProfile'];

  const resolvers = createResolvers(profile);
  const updateProfile = (
    resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>
  ).updateProfile;

  await assert.rejects(
    () => updateProfile({}, { displayName: 'Changed' }, {}),
    (error) => error instanceof Error && error.message === 'UNAUTHENTICATED'
  );
});

test('followUser maps CannotFollowSelfError to CANNOT_FOLLOW_SELF', async () => {
  const profile = createProfileStub();
  profile.commands.followUser = {
    async execute() {
      throw new CannotFollowSelfError();
    }
  } as ProfileApplicationModule['commands']['followUser'];

  const resolvers = createResolvers(profile);
  const followUser = (
    resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>
  ).followUser;

  await assert.rejects(
    () => followUser({}, { userId: 'u1' }, { userId: 'u1' }),
    (error) => error instanceof Error && error.message === 'CANNOT_FOLLOW_SELF'
  );
});

test('updateProfile maps InvalidMediaAssetError to INVALID_MEDIA_ASSET', async () => {
  const profile = createProfileStub();
  profile.commands.updateProfile = {
    async execute() {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_NOT_OWNER');
    }
  } as ProfileApplicationModule['commands']['updateProfile'];

  const resolvers = createResolvers(profile);
  const updateProfile = (
    resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>
  ).updateProfile;

  await assert.rejects(
    () =>
      updateProfile(
        {},
        { avatarAssetId: 'asset-1' },
        { userId: 'viewer' }
      ),
    (error) => error instanceof Error && error.message === 'INVALID_MEDIA_ASSET'
  );
});

test('unfollowUser maps CannotUnfollowSelfError to CANNOT_UNFOLLOW_SELF', async () => {
  const profile = createProfileStub();
  profile.commands.unfollowUser = {
    async execute() {
      throw new CannotUnfollowSelfError();
    }
  } as ProfileApplicationModule['commands']['unfollowUser'];

  const resolvers = createResolvers(profile);
  const unfollowUser = (
    resolvers.Mutation as Record<string, (...args: unknown[]) => Promise<unknown>>
  ).unfollowUser;

  await assert.rejects(
    () => unfollowUser({}, { userId: 'u1' }, { userId: 'u1' }),
    (error) => error instanceof Error && error.message === 'CANNOT_UNFOLLOW_SELF'
  );
});

test('profile resolvers delegate query and user fields to the application module', async () => {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const profile = createProfileStub();
  profile.queries.getMe = {
    async execute(ctx) {
      calls.push({ kind: 'me', payload: ctx });
      return null;
    }
  } as ProfileApplicationModule['queries']['getMe'];
  profile.queries.getUserByHandle = {
    async execute(input) {
      calls.push({ kind: 'userByHandle', payload: input });
      return null;
    }
  } as ProfileApplicationModule['queries']['getUserByHandle'];
  profile.queries.getAdminUserMetrics = {
    async execute() {
      calls.push({ kind: 'adminUserMetrics', payload: null });
      return { totalUsers: 1, newUsersToday: 1, newUsersThisWeek: 1 };
    }
  } as ProfileApplicationModule['queries']['getAdminUserMetrics'];
  profile.queries.getAdminRecentUsers = {
    async execute(input) {
      calls.push({ kind: 'adminRecentUsers', payload: input });
      return [];
    }
  } as ProfileApplicationModule['queries']['getAdminRecentUsers'];
  profile.queries.resolveUserReference = {
    async execute(input) {
      calls.push({ kind: 'resolveUserReference', payload: input });
      return {
        id: input.id,
        handle: input.id,
        displayName: input.id,
        bio: null,
        avatarKey: 'avatar.png',
        createdAt: new Date('2026-01-01T00:00:00.000Z')
      };
    }
  } as ProfileApplicationModule['queries']['resolveUserReference'];
  profile.queries.getFollowersCount = {
    async execute(input) {
      calls.push({ kind: 'followersCount', payload: input });
      return 2;
    }
  } as ProfileApplicationModule['queries']['getFollowersCount'];
  profile.queries.getFollowingCount = {
    async execute(input) {
      calls.push({ kind: 'followingCount', payload: input });
      return 3;
    }
  } as ProfileApplicationModule['queries']['getFollowingCount'];
  profile.queries.getFollowedByViewer = {
    async execute(input) {
      calls.push({ kind: 'followedByViewer', payload: input });
      return true;
    }
  } as ProfileApplicationModule['queries']['getFollowedByViewer'];
  profile.services.avatarUrlResolver = {
    resolve(key) {
      calls.push({ kind: 'avatarUrl', payload: key });
      return key ? `signed:${key}` : null;
    }
  };

  const resolvers = createResolvers(profile);
  const query = resolvers.Query as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const user = resolvers.User as Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;
  const entity = resolvers._Entity as Record<string, (value: unknown) => string | null>;

  await query.me({}, {}, { userId: 'viewer' });
  await query.userByHandle({}, { handle: 'target' }, {});
  await query.adminUserMetrics({}, {}, {});
  await query.adminRecentUsers({}, { limit: 5 }, {});
  const entities = await query._entities(
    {},
    { representations: [{ __typename: 'User', id: 'u1' }, { __typename: 'Unknown' }] },
    {}
  );

  assert.equal(entity.__resolveType({ handle: 'user_1' }), 'User');
  assert.equal(entity.__resolveType({ id: 'missing-handle' }), null);
  assert.equal(await user.avatarUrl({ avatarKey: 'avatar.png' }), 'signed:avatar.png');
  assert.equal(await user.followersCount({ id: 'u1' }), 2);
  assert.equal(await user.followingCount({ id: 'u1' }), 3);
  assert.equal(await user.followedByMe({ id: 'u1' }, {}, { userId: 'viewer' }), true);
  assert.equal(
    user.createdAt({ createdAt: new Date('2026-01-01T00:00:00.000Z') }),
    '2026-01-01T00:00:00.000Z'
  );
  assert.equal(entities[0] !== null, true);
  assert.equal(entities[1], null);
  assert.deepEqual(calls, [
    { kind: 'me', payload: { principal: { userId: 'viewer' } } },
    { kind: 'userByHandle', payload: { handle: 'target' } },
    { kind: 'adminUserMetrics', payload: null },
    { kind: 'adminRecentUsers', payload: { limit: 5 } },
    { kind: 'resolveUserReference', payload: { id: 'u1' } },
    { kind: 'avatarUrl', payload: 'avatar.png' },
    { kind: 'followersCount', payload: { userId: 'u1' } },
    { kind: 'followingCount', payload: { userId: 'u1' } },
    {
      kind: 'followedByViewer',
      payload: { viewerId: 'viewer', targetUserId: 'u1' }
    }
  ]);
});
