import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfileApplicationModule
} from '../src/application/profile/use-cases.js';
import type {
  EventPublisherPort,
  FollowRepositoryPort,
  MediaUrlSignerPort,
  ProfileReadRepositoryPort,
  UserRepositoryPort
} from '../src/application/profile/ports.js';
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
