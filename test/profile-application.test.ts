import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createProfileApplicationModule
} from '../src/application/profile/use-cases.js';
import type {
  AdminUserCursor,
  EventPublisherPort,
  FollowRepositoryPort,
  MediaAssetResolverPort,
  MediaUrlSignerPort,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
  UserSearchConnectionRecord,
  UserSearchCursor,
  UserRepositoryPort
} from '../src/application/profile/ports.js';
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  CannotFollowSelfError,
  CannotUnfollowSelfError,
  InvalidMediaAssetError
} from '../src/domain/profile/errors.js';
import type { AdminUserRecord, UserProfileRecord } from '../src/domain/profile/user-profile.js';

function makeUser(partial: Partial<AdminUserRecord> & Pick<AdminUserRecord, 'id'>): AdminUserRecord {
  return {
    id: partial.id,
    handle: partial.handle ?? `handle_${partial.id}`,
    displayName: partial.displayName ?? partial.id,
    bio: partial.bio ?? null,
    avatarKey: partial.avatarKey ?? null,
    createdAt: partial.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    status: partial.status ?? 'ACTIVE',
    deactivatedAt: partial.deactivatedAt ?? null
  };
}

class FakeUsers implements UserRepositoryPort, ProfileReadRepositoryPort {
  private readonly users = new Map<string, AdminUserRecord>();
  readonly searchCalls: Array<{ viewerId?: string; query: string; limit: number }> = [];
  readonly searchPageCalls: Array<{ viewerId?: string; query: string; cursor?: UserSearchCursor; take: number }> = [];

  seed(user: AdminUserRecord) {
    this.users.set(user.id, user);
  }

  async findById(id: string): Promise<UserProfileRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByHandle(handle: string): Promise<UserProfileRecord | null> {
    return Array.from(this.users.values()).find((user) => user.status === 'ACTIVE' && user.handle === handle) ?? null;
  }

  async findAdminById(id: string): Promise<AdminUserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async searchUsers(input: { viewerId?: string; query: string; limit: number }): Promise<UserProfileRecord[]> {
    this.searchCalls.push(input);
    const rows = await this.searchUsersPage({
      viewerId: input.viewerId,
      query: input.query,
      take: input.limit
    });

    return rows.map((row) => row.user);
  }

  async searchUsersPage(input: {
    viewerId?: string;
    query: string;
    cursor?: UserSearchCursor;
    take: number;
  }): Promise<UserSearchConnectionRecord[]> {
    this.searchPageCalls.push(input);
    const normalizedQuery = input.query.trim().replace(/^@/, '').toLowerCase();
    const rows = Array.from(this.users.values())
      .filter((user) => user.status === 'ACTIVE')
      .filter((user) => user.id !== input.viewerId)
      .filter((user) => {
        const handle = user.handle.toLowerCase();
        const displayName = user.displayName.toLowerCase();
        return handle.includes(normalizedQuery) || displayName.includes(normalizedQuery);
      })
      .map((user) => ({
        user,
        matchScore:
          user.handle.toLowerCase() === normalizedQuery
            ? 0
            : user.handle.toLowerCase().startsWith(normalizedQuery)
              ? 1
              : user.displayName.toLowerCase() === normalizedQuery
                ? 2
                : user.displayName.toLowerCase().startsWith(normalizedQuery)
                  ? 3
                  : user.handle.toLowerCase().includes(normalizedQuery)
                    ? 4
                    : 5
      }))
      .sort((left, right) => {
        const scoreDiff = left.matchScore - right.matchScore;
        if (scoreDiff !== 0) return scoreDiff;
        const dateDiff = right.user.createdAt.getTime() - left.user.createdAt.getTime();
        if (dateDiff !== 0) return dateDiff;
        const handleDiff = left.user.handle.localeCompare(right.user.handle);
        if (handleDiff !== 0) return handleDiff;
        return left.user.id.localeCompare(right.user.id);
      });

    const filtered = input.cursor
      ? rows.filter((row) => {
          if (row.matchScore !== input.cursor!.matchScore) {
            return row.matchScore > input.cursor!.matchScore;
          }
          const createdAtDiff = row.user.createdAt.getTime() - input.cursor!.createdAt.getTime();
          if (createdAtDiff !== 0) {
            return createdAtDiff < 0;
          }
          const handleDiff = row.user.handle.localeCompare(input.cursor!.handle);
          if (handleDiff !== 0) {
            return handleDiff > 0;
          }
          return row.user.id.localeCompare(input.cursor!.userId) > 0;
        })
      : rows;

    return filtered.slice(0, input.take);
  }

  async findOrCreateWithFallback(input: {
    id: string;
    preferredHandle?: string | null;
    displayName?: string | null;
    bio?: string | null;
    avatarKey?: string | null;
  }): Promise<UserProfileRecord> {
    const existing = this.users.get(input.id);
    if (existing) {
      return existing;
    }
    const created = makeUser({
      id: input.id,
      handle: (input.preferredHandle ?? input.id).replace(/[^a-zA-Z0-9_]/g, '_'),
      displayName: input.displayName ?? input.id,
      bio: input.bio ?? null,
      avatarKey: input.avatarKey ?? null
    });
    this.users.set(created.id, created);
    return created;
  }

  async upsertProfile(
    userId: string,
    patch: { displayName?: string; bio?: string | null; avatarKey?: string | null }
  ): Promise<UserProfileRecord> {
    const existing = this.users.get(userId);
    const next = makeUser({
      id: userId,
      handle: existing?.handle ?? `user_${userId}`,
      displayName: patch.displayName ?? existing?.displayName ?? 'New User',
      bio: patch.bio === undefined ? (existing?.bio ?? null) : patch.bio,
      avatarKey:
        patch.avatarKey === undefined ? (existing?.avatarKey ?? null) : patch.avatarKey,
      status: existing?.status ?? 'ACTIVE',
      deactivatedAt: existing?.deactivatedAt ?? null
    });
    this.users.set(userId, next);
    return next;
  }

  async listDiscoverableUsers(input: { viewerId: string; limit: number }): Promise<UserProfileRecord[]> {
    return Array.from(this.users.values())
      .filter((user) => user.status === 'ACTIVE')
      .filter((user) => user.id !== input.viewerId)
      .sort((a, b) => {
        const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (dateDiff !== 0) return dateDiff;
        return b.id.localeCompare(a.id);
      })
      .slice(0, input.limit);
  }

  async updateAdminStatus(input: {
    userId: string;
    status: 'ACTIVE' | 'DEACTIVATED';
  }): Promise<AdminUserRecord | null> {
    const existing = this.users.get(input.userId);
    if (!existing) {
      return null;
    }
    const updated = {
      ...existing,
      status: input.status,
      deactivatedAt: input.status === 'DEACTIVATED' ? new Date('2026-01-06T00:00:00.000Z') : null
    };
    this.users.set(input.userId, updated);
    return updated;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async countUsersCreatedSince(since: Date): Promise<number> {
    return Array.from(this.users.values()).filter((user) => user.createdAt >= since).length;
  }

  async listRecentUsers(limit: number): Promise<AdminUserRecord[]> {
    return Array.from(this.users.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async listAdminUsers(input: {
    query?: string;
    status?: 'ACTIVE' | 'DEACTIVATED';
    cursor?: AdminUserCursor;
    take: number;
  }): Promise<AdminUserRecord[]> {
    const normalizedQuery = input.query?.trim().toLowerCase();
    const rows = Array.from(this.users.values())
      .filter((user) => (input.status ? user.status === input.status : true))
      .filter((user) => {
        if (!normalizedQuery) return true;
        return (
          user.id.toLowerCase().includes(normalizedQuery)
          || user.handle.toLowerCase().includes(normalizedQuery)
          || user.displayName.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => {
        const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (dateDiff !== 0) return dateDiff;
        return b.id.localeCompare(a.id);
      });

    const filtered = input.cursor
      ? rows.filter(
          (user) =>
            user.createdAt.getTime() < input.cursor!.createdAt.getTime()
            || (
              user.createdAt.getTime() === input.cursor!.createdAt.getTime()
              && user.id < input.cursor!.userId
            )
        )
      : rows;

    return filtered.slice(0, input.take);
  }
}

class FakeFollows implements FollowRepositoryPort {
  private readonly edges = new Map<string, Date>();

  private key(followerId: string, followingId: string) {
    return `${followerId}->${followingId}`;
  }

  async upsertFollow(followerId: string, followingId: string): Promise<void> {
    this.edges.set(this.key(followerId, followingId), new Date());
  }

  async deleteFollowIfExists(followerId: string, followingId: string): Promise<void> {
    this.edges.delete(this.key(followerId, followingId));
  }

  async countFollowers(userId: string): Promise<number> {
    return Array.from(this.edges.keys()).filter((edge) => edge.endsWith(`->${userId}`)).length;
  }

  async countFollowing(userId: string): Promise<number> {
    return Array.from(this.edges.keys()).filter((edge) => edge.startsWith(`${userId}->`)).length;
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    return this.edges.has(this.key(followerId, followingId));
  }

  async listFollowers(input: {
    userId: string;
    cursor?: { createdAt: Date; userId: string };
    take: number;
  }) {
    const rows = Array.from(this.edges.entries())
      .map(([key, createdAt]) => {
        const [followerId, followingId] = key.split('->');
        return { followerId, followingId, createdAt };
      })
      .filter((row) => row.followingId === input.userId)
      .sort((a, b) => {
        const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (dateDiff !== 0) return dateDiff;
        return b.followerId.localeCompare(a.followerId);
      });

    const filtered = input.cursor
      ? rows.filter(
          (row) =>
            row.createdAt.getTime() < input.cursor!.createdAt.getTime()
            || (
              row.createdAt.getTime() === input.cursor!.createdAt.getTime()
              && row.followerId < input.cursor!.userId
            )
        )
      : rows;

    return filtered.slice(0, input.take).map((row) => ({
      user: makeUser({ id: row.followerId, handle: row.followerId }),
      followedAt: row.createdAt
    }));
  }

  async listFollowing(input: {
    userId: string;
    cursor?: { createdAt: Date; userId: string };
    take: number;
  }) {
    const rows = Array.from(this.edges.entries())
      .map(([key, createdAt]) => {
        const [followerId, followingId] = key.split('->');
        return { followerId, followingId, createdAt };
      })
      .filter((row) => row.followerId === input.userId)
      .sort((a, b) => {
        const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (dateDiff !== 0) return dateDiff;
        return b.followingId.localeCompare(a.followingId);
      });

    const filtered = input.cursor
      ? rows.filter(
          (row) =>
            row.createdAt.getTime() < input.cursor!.createdAt.getTime()
            || (
              row.createdAt.getTime() === input.cursor!.createdAt.getTime()
              && row.followingId < input.cursor!.userId
            )
        )
      : rows;

    return filtered.slice(0, input.take).map((row) => ({
      user: makeUser({ id: row.followingId, handle: row.followingId }),
      followedAt: row.createdAt
    }));
  }
}

class FakeEvents implements EventPublisherPort {
  published: Array<{ topic: string; eventType: string; key: string; envelope: unknown }> = [];

  async publish<TData>(
    request: { topic: string; eventType: string; key: string },
    envelope: unknown
  ): Promise<void> {
    this.published.push({
      topic: request.topic,
      eventType: request.eventType,
      key: request.key,
      envelope
    });
  }
}

class FakeMedia implements MediaUrlSignerPort {
  signMediaUrl(key: string): string {
    return `https://cdn.test/${key}`;
  }
}

class FakeMediaAssetResolver implements MediaAssetResolverPort {
  private readonly assets = new Map<string, { ownerId: string; status: string; key: string }>();

  seed(input: { assetId: string; ownerId: string; status: string; key: string }) {
    this.assets.set(input.assetId, {
      ownerId: input.ownerId,
      status: input.status,
      key: input.key
    });
  }

  async resolveOwnedReadyAsset(input: {
    assetId: string;
    userId: string;
  }): Promise<{ key: string }> {
    const asset = this.assets.get(input.assetId);
    if (!asset) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_NOT_FOUND');
    }
    if (asset.ownerId !== input.userId) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_OWNER');
    }
    if (asset.status !== 'ready') {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_NOT_READY');
    }
    return { key: asset.key };
  }
}

test('bootstrapUser returns existing user without publishing duplicate event', async () => {
  const users = new FakeUsers();
  users.seed(makeUser({ id: 'u1', handle: 'u1_handle' }));
  const events = new FakeEvents();

  const module = createProfileApplicationModule({
    users,
    follows: new FakeFollows(),
    profileRead: users,
    eventPublisher: events,
    mediaUrlSigner: new FakeMedia(),
    eventProducerName: 'svc-profile'
  });

  const result = await module.commands.bootstrapUser.execute({
    id: 'u1',
    preferredHandle: 'u1'
  });

  assert.deepEqual(result, { created: false, userId: 'u1' });
  assert.equal(events.published.length, 0);
});

test('followUser publishes integration event and returns target user', async () => {
  const users = new FakeUsers();
  users.seed(makeUser({ id: 'viewer', handle: 'viewer' }));
  const events = new FakeEvents();

  const module = createProfileApplicationModule({
    users,
    follows: new FakeFollows(),
    profileRead: users,
    eventPublisher: events,
    mediaUrlSigner: new FakeMedia(),
    eventProducerName: 'svc-profile'
  });

  const user = await module.commands.followUser.execute(
    { userId: 'target' },
    { principal: { userId: 'viewer', roles: [] }, correlationId: 'c1' }
  );

  assert.equal(user.id, 'target');
  assert.equal(events.published.length, 1);
  assert.equal(events.published[0]?.topic, 'profile.user.followed.v1');
});

test('profile application commands and queries cover mutations, auth, and metrics', async () => {
  const users = new FakeUsers();
  users.seed(
    makeUser({
      id: 'viewer',
      handle: 'viewer',
      displayName: 'Viewer',
      avatarKey: 'avatar.png',
      createdAt: new Date('2026-01-05T09:00:00.000Z')
    })
  );
  users.seed(
    makeUser({
      id: 'target',
      handle: 'target',
      displayName: 'Target',
      createdAt: new Date('2026-01-05T08:00:00.000Z')
    })
  );
  users.seed(
    makeUser({
      id: 'older',
      handle: 'older',
      createdAt: new Date('2025-12-31T23:00:00.000Z')
    })
  );

  const follows = new FakeFollows();
  await follows.upsertFollow('viewer', 'target');
  await follows.upsertFollow('other', 'target');

  const events = new FakeEvents();
  let recentLimit = 0;
  const profileRead: ProfileReadRepositoryPort = {
    countUsers: () => users.countUsers(),
    countUsersCreatedSince: (since) => users.countUsersCreatedSince(since),
    listRecentUsers: async (limit) => {
      recentLimit = limit;
      return users.listRecentUsers(limit);
    },
    listAdminUsers: (input) => users.listAdminUsers(input)
  };

  let transactionCount = 0;
  const transactionRunner: ProfileTransactionPort = {
    async run<T>(callback): Promise<T> {
      transactionCount += 1;
      return callback({
        users,
        follows,
        eventPublisher: events
      });
    }
  };

  const module = createProfileApplicationModule({
    users,
    follows,
    profileRead,
    eventPublisher: events,
    mediaUrlSigner: new FakeMedia(),
    eventProducerName: 'svc-profile',
    transactionRunner
  });

  const bootstrapped = await module.commands.bootstrapUser.execute({
    id: 'fresh',
    preferredHandle: 'Fresh User',
    displayName: 'Fresh User'
  });
  assert.deepEqual(bootstrapped, {
    created: true,
    userId: 'fresh',
    handle: 'Fresh_User'
  });

  const updated = await module.commands.updateProfile.execute(
    { displayName: 'Viewer Updated', bio: 'bio', avatarKey: 'next.png' },
    {
      principal: { userId: 'viewer', roles: [] },
      correlationId: 'corr-1',
      causationId: 'cause-1',
      tenantId: 'tenant-1'
    }
  );
  assert.equal(updated.displayName, 'Viewer Updated');
  assert.equal(updated.avatarKey, 'next.png');

  const unfollowed = await module.commands.unfollowUser.execute(
    { userId: 'target' },
    { principal: { userId: 'viewer', roles: [] }, correlationId: 'corr-2' }
  );
  assert.equal(unfollowed.id, 'target');
  assert.equal(await follows.isFollowing('viewer', 'target'), false);

  assert.equal(transactionCount, 3);
  assert.deepEqual(
    events.published.map((event) => event.topic),
    [
      'profile.user.bootstrapped.v1',
      'profile.user.updated.v1',
      'profile.user.unfollowed.v1'
    ]
  );

  assert.equal(
    (await module.queries.getMe.execute({ principal: { userId: 'viewer', roles: [] } }))?.id,
    'viewer'
  );
  assert.equal(await module.queries.getMe.execute({}), null);
  assert.equal(
    (await module.queries.getUserByHandle.execute({ handle: 'target' }))?.id,
    'target'
  );

  const metrics = await module.queries.getAdminUserMetrics.execute(
    { principal: { userId: 'admin-1', roles: ['admin'] } },
    new Date('2026-01-05T12:00:00.000Z')
  );
  assert.deepEqual(metrics, {
    totalUsers: 4,
    newUsersToday: 1,
    newUsersThisWeek: 1
  });

  const recentUsers = await module.queries.getAdminRecentUsers.execute(
    { limit: 999 },
    { principal: { userId: 'admin-1', roles: ['admin'] } }
  );
  assert.equal(recentLimit, 50);
  assert.equal(recentUsers[0]?.id, 'target');
  const adminUsers = await module.queries.getAdminUsers.execute(
    { query: 'viewer', status: 'ACTIVE', limit: 5 },
    { principal: { userId: 'admin-1', roles: ['admin'] } }
  );
  assert.equal(adminUsers.edges[0]?.node.id, 'viewer');
  assert.equal(adminUsers.pageInfo.hasNextPage, false);
  const discoverUsers = await module.queries.discoverUsers.execute({ viewerId: 'viewer', limit: 2 });
  assert.equal(discoverUsers.length, 2);
  const searchUsers = await module.queries.searchUsers.execute({ viewerId: 'viewer', query: '@tar', limit: 5 });
  assert.equal(searchUsers[0]?.id, 'target');
  assert.deepEqual(users.searchCalls.at(-1), {
    viewerId: 'viewer',
    query: 'tar',
    limit: 5
  });
  const searchUsersConnection = await module.queries.searchUsersConnection.execute({
    viewerId: 'viewer',
    query: '@tar',
    limit: 1
  });
  assert.equal(searchUsersConnection.edges[0]?.node.id, 'target');
  assert.equal(searchUsersConnection.pageInfo.hasNextPage, false);
  assert.deepEqual(users.searchPageCalls.at(-1), {
    viewerId: 'viewer',
    query: 'tar',
    cursor: undefined,
    take: 2
  });

  const resolved = await module.queries.resolveUserReference.execute({ id: 'ref-user' });
  assert.equal(resolved.id, 'ref-user');
  assert.equal(await module.queries.getFollowersCount.execute({ userId: 'target' }), 1);
  assert.equal(await module.queries.getFollowingCount.execute({ userId: 'viewer' }), 0);
  assert.equal(
    await module.queries.getFollowedByViewer.execute({
      viewerId: 'viewer',
      targetUserId: 'viewer'
    }),
    false
  );
  assert.equal(
    await module.queries.getFollowedByViewer.execute({
      viewerId: 'other',
      targetUserId: 'target'
    }),
    true
  );
  const followersConnection = await module.queries.getFollowersConnection.execute({
    userId: 'target',
    limit: 20
  });
  assert.equal(followersConnection.edges.length, 1);
  assert.equal(followersConnection.pageInfo.hasNextPage, false);
  const followingConnection = await module.queries.getFollowingConnection.execute({
    userId: 'viewer',
    limit: 20
  });
  assert.equal(followingConnection.edges.length, 0);
  assert.equal(module.services.avatarUrlResolver.resolve('avatar.png'), 'https://cdn.test/avatar.png');
  assert.equal(module.services.avatarUrlResolver.resolve(null), null);

  const deactivated = await module.commands.adminDeactivateUser.execute(
    { userId: 'target' },
    { principal: { userId: 'admin-1', roles: ['admin'] }, correlationId: 'corr-3' }
  );
  assert.equal(deactivated.status, 'DEACTIVATED');
  const reactivated = await module.commands.adminReactivateUser.execute(
    { userId: 'target' },
    { principal: { userId: 'admin-1', roles: ['admin'] }, correlationId: 'corr-4' }
  );
  assert.equal(reactivated.status, 'ACTIVE');
  assert.deepEqual(
    events.published.slice(-2).map((event) => event.topic),
    ['profile.user.deactivated.v1', 'profile.user.reactivated.v1']
  );
});

test('profile application surfaces auth and self-follow domain errors', async () => {
  const users = new FakeUsers();
  users.seed(makeUser({ id: 'viewer', handle: 'viewer' }));
  const module = createProfileApplicationModule({
    users,
    follows: new FakeFollows(),
    profileRead: users,
    eventPublisher: new FakeEvents(),
    mediaUrlSigner: new FakeMedia(),
    eventProducerName: 'svc-profile'
  });

  await assert.rejects(
    () => module.commands.updateProfile.execute({ displayName: 'Nope' }, {}),
    (error) => error instanceof AuthenticationRequiredError
  );
  await assert.rejects(
    () => module.commands.followUser.execute({ userId: 'viewer' }, { principal: { userId: 'viewer', roles: [] } }),
    (error) => error instanceof CannotFollowSelfError
  );
  await assert.rejects(
    () => module.commands.unfollowUser.execute({ userId: 'viewer' }, { principal: { userId: 'viewer', roles: [] } }),
    (error) => error instanceof CannotUnfollowSelfError
  );
  await assert.rejects(
    () => module.queries.getAdminUserMetrics.execute({ principal: { userId: 'viewer', roles: [] } }),
    (error) => error instanceof AuthorizationRequiredError
  );
});

test('searchUsersConnection preserves ranked ordering across cursored pages', async () => {
  const users = new FakeUsers();
  users.seed(makeUser({ id: 'viewer', handle: 'viewer', displayName: 'Viewer', createdAt: new Date('2026-01-05T00:00:00.000Z') }));
  users.seed(makeUser({ id: 'exact-handle', handle: 'alex', displayName: 'Someone Else', createdAt: new Date('2026-01-04T00:00:00.000Z') }));
  users.seed(makeUser({ id: 'handle-prefix', handle: 'alexander', displayName: 'Alexander', createdAt: new Date('2026-01-03T00:00:00.000Z') }));
  users.seed(makeUser({ id: 'display-exact', handle: 'teammate', displayName: 'Alex', createdAt: new Date('2026-01-02T00:00:00.000Z') }));
  users.seed(makeUser({ id: 'handle-contains', handle: 'team-alex', displayName: 'Teammate', createdAt: new Date('2026-01-01T00:00:00.000Z') }));

  const module = createProfileApplicationModule({
    users,
    follows: new FakeFollows(),
    profileRead: users,
    eventPublisher: new FakeEvents(),
    mediaUrlSigner: new FakeMedia(),
    eventProducerName: 'svc-profile'
  });

  const firstPage = await module.queries.searchUsersConnection.execute({
    viewerId: 'viewer',
    query: 'alex',
    limit: 2
  });

  assert.deepEqual(
    firstPage.edges.map((edge) => edge.node.id),
    ['exact-handle', 'handle-prefix']
  );
  assert.equal(firstPage.pageInfo.hasNextPage, true);

  const secondPage = await module.queries.searchUsersConnection.execute({
    viewerId: 'viewer',
    query: 'alex',
    after: firstPage.pageInfo.endCursor ?? undefined,
    limit: 2
  });

  assert.deepEqual(
    secondPage.edges.map((edge) => edge.node.id),
    ['display-exact', 'handle-contains']
  );
  assert.equal(secondPage.pageInfo.hasNextPage, false);
});

test('updateProfile resolves avatarAssetId with precedence over avatarKey and supports removal', async () => {
  const users = new FakeUsers();
  users.seed(
    makeUser({
      id: 'viewer',
      handle: 'viewer',
      displayName: 'Viewer',
      avatarKey: 'current.png'
    })
  );

  const mediaAssetResolver = new FakeMediaAssetResolver();
  mediaAssetResolver.seed({
    assetId: 'asset-1',
    ownerId: 'viewer',
    status: 'ready',
    key: 'assets/avatar-1.png'
  });

  const module = createProfileApplicationModule({
    users,
    follows: new FakeFollows(),
    profileRead: users,
    eventPublisher: new FakeEvents(),
    mediaUrlSigner: new FakeMedia(),
    mediaAssetResolver,
    eventProducerName: 'svc-profile'
  });

  const updatedWithAsset = await module.commands.updateProfile.execute(
    {
      avatarKey: 'legacy.png',
      avatarAssetId: 'asset-1'
    },
    { principal: { userId: 'viewer' } }
  );
  assert.equal(updatedWithAsset.avatarKey, 'assets/avatar-1.png');

  const removedAvatar = await module.commands.updateProfile.execute(
    {
      avatarKey: 'should-not-win.png',
      avatarAssetId: null
    },
    { principal: { userId: 'viewer' } }
  );
  assert.equal(removedAvatar.avatarKey, null);

  await assert.rejects(
    () =>
      module.commands.updateProfile.execute(
        {
          avatarAssetId: 'missing-asset'
        },
        { principal: { userId: 'viewer' } }
      ),
    (error) =>
      error instanceof InvalidMediaAssetError
      && error.code === 'INVALID_MEDIA_ASSET'
      && error.message === 'INVALID_MEDIA_ASSET_NOT_FOUND'
  );
});
