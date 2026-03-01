import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createProfileApplicationModule
} from '../src/application/profile/use-cases.js';
import type {
  EventPublisherPort,
  FollowRepositoryPort,
  MediaUrlSignerPort,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
  UserRepositoryPort
} from '../src/application/profile/ports.js';
import {
  AuthenticationRequiredError,
  CannotFollowSelfError,
  CannotUnfollowSelfError
} from '../src/domain/profile/errors.js';
import type { UserProfileRecord } from '../src/domain/profile/user-profile.js';

function makeUser(partial: Partial<UserProfileRecord> & Pick<UserProfileRecord, 'id'>): UserProfileRecord {
  return {
    id: partial.id,
    handle: partial.handle ?? `handle_${partial.id}`,
    displayName: partial.displayName ?? partial.id,
    bio: partial.bio ?? null,
    avatarKey: partial.avatarKey ?? null,
    createdAt: partial.createdAt ?? new Date('2026-01-01T00:00:00.000Z')
  };
}

class FakeUsers implements UserRepositoryPort, ProfileReadRepositoryPort {
  private readonly users = new Map<string, UserProfileRecord>();

  seed(user: UserProfileRecord) {
    this.users.set(user.id, user);
  }

  async findById(id: string): Promise<UserProfileRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByHandle(handle: string): Promise<UserProfileRecord | null> {
    return Array.from(this.users.values()).find((user) => user.handle === handle) ?? null;
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
        patch.avatarKey === undefined ? (existing?.avatarKey ?? null) : patch.avatarKey
    });
    this.users.set(userId, next);
    return next;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async countUsersCreatedSince(since: Date): Promise<number> {
    return Array.from(this.users.values()).filter((user) => user.createdAt >= since).length;
  }

  async listRecentUsers(limit: number): Promise<UserProfileRecord[]> {
    return Array.from(this.users.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

class FakeFollows implements FollowRepositoryPort {
  private readonly edges = new Set<string>();

  private key(followerId: string, followingId: string) {
    return `${followerId}->${followingId}`;
  }

  async upsertFollow(followerId: string, followingId: string): Promise<void> {
    this.edges.add(this.key(followerId, followingId));
  }

  async deleteFollowIfExists(followerId: string, followingId: string): Promise<void> {
    this.edges.delete(this.key(followerId, followingId));
  }

  async countFollowers(userId: string): Promise<number> {
    return Array.from(this.edges).filter((edge) => edge.endsWith(`->${userId}`)).length;
  }

  async countFollowing(userId: string): Promise<number> {
    return Array.from(this.edges).filter((edge) => edge.startsWith(`${userId}->`)).length;
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    return this.edges.has(this.key(followerId, followingId));
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
    { principal: { userId: 'viewer' }, correlationId: 'c1' }
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
    }
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
      principal: { userId: 'viewer' },
      correlationId: 'corr-1',
      causationId: 'cause-1',
      tenantId: 'tenant-1'
    }
  );
  assert.equal(updated.displayName, 'Viewer Updated');
  assert.equal(updated.avatarKey, 'next.png');

  const unfollowed = await module.commands.unfollowUser.execute(
    { userId: 'target' },
    { principal: { userId: 'viewer' }, correlationId: 'corr-2' }
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
    (await module.queries.getMe.execute({ principal: { userId: 'viewer' } }))?.id,
    'viewer'
  );
  assert.equal(await module.queries.getMe.execute({}), null);
  assert.equal(
    (await module.queries.getUserByHandle.execute({ handle: 'target' }))?.id,
    'target'
  );

  const metrics = await module.queries.getAdminUserMetrics.execute(
    new Date('2026-01-05T12:00:00.000Z')
  );
  assert.deepEqual(metrics, {
    totalUsers: 4,
    newUsersToday: 1,
    newUsersThisWeek: 1
  });

  const recentUsers = await module.queries.getAdminRecentUsers.execute({ limit: 999 });
  assert.equal(recentLimit, 50);
  assert.equal(recentUsers[0]?.id, 'target');

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
  assert.equal(module.services.avatarUrlResolver.resolve('avatar.png'), 'https://cdn.test/avatar.png');
  assert.equal(module.services.avatarUrlResolver.resolve(null), null);
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
    () => module.commands.followUser.execute({ userId: 'viewer' }, { principal: { userId: 'viewer' } }),
    (error) => error instanceof CannotFollowSelfError
  );
  await assert.rejects(
    () => module.commands.unfollowUser.execute({ userId: 'viewer' }, { principal: { userId: 'viewer' } }),
    (error) => error instanceof CannotUnfollowSelfError
  );
});
