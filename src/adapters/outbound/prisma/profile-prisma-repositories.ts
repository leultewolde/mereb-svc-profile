import type { IntegrationEventEnvelope } from '@mereb/shared-packages';
import type {
  EventPublisherPort,
  FollowRepositoryPort,
  ProfileMutationPorts,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
  UserConnectionRecord,
  UserFollowCursor,
  UserRepositoryPort
} from '../../../application/profile/ports.js';
import type { ProfileIntegrationEventRequest } from '../../../contracts/profile-events.js';
import {
  buildBootstrapUserDraft,
  buildProfileUpsertCreate,
  deriveHandle,
  type BootstrapUserDraft,
  type UpdateProfilePatch,
  type UserProfileRecord
} from '../../../domain/profile/user-profile.js';
import { prisma } from '../../../prisma.js';
import { OutboxStatus, type Prisma, type PrismaClient } from '../../../../generated/client/index.js';

type ProfilePrismaDb = PrismaClient | Prisma.TransactionClient;

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

function toUserRecord(input: {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
}): UserProfileRecord {
  return {
    id: input.id,
    handle: input.handle,
    displayName: input.displayName,
    bio: input.bio,
    avatarKey: input.avatarKey,
    createdAt: input.createdAt
  };
}

function normalizeUserSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function scoreUserSearchMatch(
  user: Pick<UserProfileRecord, 'handle' | 'displayName'>,
  query: string
): number {
  const handle = normalizeUserSearchText(user.handle);
  const displayName = normalizeUserSearchText(user.displayName);

  if (handle === query) return 0;
  if (handle.startsWith(query)) return 1;
  if (displayName === query) return 2;
  if (displayName.startsWith(query)) return 3;
  if (handle.includes(query)) return 4;
  if (displayName.includes(query)) return 5;
  return 6;
}

function followCursorWhere(cursor: UserFollowCursor | undefined, idField: 'followerId' | 'followingId'): Prisma.FollowWhereInput | undefined {
  if (!cursor) {
    return undefined;
  }
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        [idField]: { lt: cursor.userId }
      }
    ]
  };
}

export class PrismaUserRepository implements UserRepositoryPort, ProfileReadRepositoryPort {
  constructor(private readonly db: ProfilePrismaDb = prisma) {}

  async findById(id: string): Promise<UserProfileRecord | null> {
    const user = await this.db.user.findUnique({ where: { id } });
    return user ? toUserRecord(user) : null;
  }

  async findByHandle(handle: string): Promise<UserProfileRecord | null> {
    const user = await this.db.user.findUnique({ where: { handle } });
    return user ? toUserRecord(user) : null;
  }

  async searchUsers(input: { viewerId?: string; query: string; limit: number }): Promise<UserProfileRecord[]> {
    const normalizedQuery = normalizeUserSearchText(input.query);
    if (!normalizedQuery) {
      return [];
    }

    const users = await this.db.user.findMany({
      where: {
        ...(input.viewerId ? { id: { not: input.viewerId } } : {}),
        OR: [
          {
            handle: {
              contains: normalizedQuery,
              mode: 'insensitive'
            }
          },
          {
            displayName: {
              contains: normalizedQuery,
              mode: 'insensitive'
            }
          }
        ]
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.max(input.limit * 4, input.limit)
    });

    return users
      .map(toUserRecord)
      .sort((left, right) => {
        const scoreDiff =
          scoreUserSearchMatch(left, normalizedQuery) -
          scoreUserSearchMatch(right, normalizedQuery);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }

        const dateDiff = right.createdAt.getTime() - left.createdAt.getTime();
        if (dateDiff !== 0) {
          return dateDiff;
        }

        return left.handle.localeCompare(right.handle);
      })
      .slice(0, input.limit);
  }

  async findOrCreateWithFallback(input: BootstrapUserDraft): Promise<UserProfileRecord> {
    const existing = await this.db.user.findUnique({ where: { id: input.id } });
    if (existing) {
      return toUserRecord(existing);
    }

    const draft = buildBootstrapUserDraft(input);

    try {
      const created = await this.db.user.create({ data: draft });
      return toUserRecord(created);
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) {
        throw error;
      }

      const uniqueHandle = `${draft.handle}_${cryptoSuffix()}`.slice(0, 32);
      const created = await this.db.user.create({
        data: {
          id: draft.id,
          handle: uniqueHandle,
          displayName: draft.displayName,
          bio: draft.bio,
          avatarKey: draft.avatarKey
        }
      });

      return toUserRecord(created);
    }
  }

  async upsertProfile(userId: string, patch: UpdateProfilePatch): Promise<UserProfileRecord> {
    const updated = await this.db.user.upsert({
      where: { id: userId },
      update: {
        ...(patch.displayName ? { displayName: patch.displayName } : {}),
        ...(patch.bio === undefined ? {} : { bio: patch.bio }),
        ...(patch.avatarKey === undefined ? {} : { avatarKey: patch.avatarKey })
      },
      create: buildProfileUpsertCreate(userId, patch)
    });

    return toUserRecord(updated);
  }

  async countUsers(): Promise<number> {
    return this.db.user.count();
  }

  async listDiscoverableUsers(input: { viewerId: string; limit: number }): Promise<UserProfileRecord[]> {
    const users = await this.db.user.findMany({
      where: {
        id: { not: input.viewerId },
        followers: {
          none: {
            followerId: input.viewerId
          }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit
    });
    return users.map(toUserRecord);
  }

  async countUsersCreatedSince(since: Date): Promise<number> {
    return this.db.user.count({
      where: {
        createdAt: { gte: since }
      }
    });
  }

  async listRecentUsers(limit: number): Promise<UserProfileRecord[]> {
    const users = await this.db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    return users.map(toUserRecord);
  }
}

export class PrismaFollowRepository implements FollowRepositoryPort {
  constructor(private readonly db: ProfilePrismaDb = prisma) {}

  async upsertFollow(followerId: string, followingId: string): Promise<void> {
    await this.db.follow.upsert({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      },
      update: {},
      create: {
        followerId,
        followingId
      }
    });
  }

  async deleteFollowIfExists(followerId: string, followingId: string): Promise<void> {
    await this.db.follow
      .delete({
        where: {
          followerId_followingId: {
            followerId,
            followingId
          }
        }
      })
      .catch((error) => {
        if (!isPrismaCode(error, 'P2025')) {
          throw error;
        }
      });
  }

  async countFollowers(userId: string): Promise<number> {
    return this.db.follow.count({
      where: {
        followingId: userId
      }
    });
  }

  async countFollowing(userId: string): Promise<number> {
    return this.db.follow.count({
      where: {
        followerId: userId
      }
    });
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const existing = await this.db.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId,
          followingId
        }
      }
    });

    return Boolean(existing);
  }

  async listFollowers(input: { userId: string; cursor?: UserFollowCursor; take: number }): Promise<UserConnectionRecord[]> {
    const rows = await this.db.follow.findMany({
      where: {
        followingId: input.userId,
        ...followCursorWhere(input.cursor, 'followerId')
      },
      include: {
        follower: true
      },
      orderBy: [{ createdAt: 'desc' }, { followerId: 'desc' }],
      take: input.take
    });
    return rows.map((row) => ({
      user: toUserRecord(row.follower),
      followedAt: row.createdAt
    }));
  }

  async listFollowing(input: { userId: string; cursor?: UserFollowCursor; take: number }): Promise<UserConnectionRecord[]> {
    const rows = await this.db.follow.findMany({
      where: {
        followerId: input.userId,
        ...followCursorWhere(input.cursor, 'followingId')
      },
      include: {
        following: true
      },
      orderBy: [{ createdAt: 'desc' }, { followingId: 'desc' }],
      take: input.take
    });
    return rows.map((row) => ({
      user: toUserRecord(row.following),
      followedAt: row.createdAt
    }));
  }
}

export class PrismaProfileOutboxEventPublisher implements EventPublisherPort {
  constructor(private readonly db: ProfilePrismaDb = prisma) {}

  async publish<TData>(
    request: ProfileIntegrationEventRequest<TData>,
    envelope: IntegrationEventEnvelope<TData>
  ): Promise<void> {
    await this.db.outboxEvent.create({
      data: {
        id: envelope.event_id,
        topic: request.topic,
        eventType: request.eventType,
        eventKey: request.key,
        payload: envelope as unknown as Prisma.InputJsonValue,
        status: OutboxStatus.PENDING
      }
    });
  }
}

export interface PendingProfileOutboxEvent {
  id: string;
  topic: string;
  eventType: string;
  eventKey: string | null;
  envelope: IntegrationEventEnvelope<unknown>;
  attempts: number;
}

export interface ProfileOutboxStatusCounts {
  pending: number;
  processing: number;
  published: number;
  failed: number;
  deadLetter: number;
}

export class PrismaProfileOutboxRelayStore {
  constructor(private readonly db: ProfilePrismaDb = prisma) {}

  async listDue(limit: number, now = new Date()): Promise<PendingProfileOutboxEvent[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: {
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
        nextAttemptAt: { lte: now }
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit
    });

    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      eventType: row.eventType,
      eventKey: row.eventKey,
      envelope: row.payload as unknown as IntegrationEventEnvelope<unknown>,
      attempts: row.attempts
    }));
  }

  async claim(id: string): Promise<boolean> {
    const result = await this.db.outboxEvent.updateMany({
      where: {
        id,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] }
      },
      data: {
        status: OutboxStatus.PROCESSING,
        attempts: { increment: 1 },
        lastError: null
      }
    });

    return result.count > 0;
  }

  async markPublished(id: string, publishedAt = new Date()): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: OutboxStatus.PUBLISHED,
        publishedAt,
        lastError: null
      }
    });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: OutboxStatus.FAILED,
        lastError: error.slice(0, 4000),
        nextAttemptAt,
        publishedAt: null,
        deadLetteredAt: null,
        deadLetterTopic: null
      }
    });
  }

  async markDeadLetter(
    id: string,
    error: string,
    input?: { deadLetteredAt?: Date; deadLetterTopic?: string | null }
  ): Promise<void> {
    await this.db.outboxEvent.updateMany({
      where: { id },
      data: {
        status: OutboxStatus.DEAD_LETTER,
        lastError: error.slice(0, 4000),
        deadLetteredAt: input?.deadLetteredAt ?? new Date(),
        deadLetterTopic: input?.deadLetterTopic ?? null,
        publishedAt: null
      }
    });
  }

  async countByStatus(): Promise<ProfileOutboxStatusCounts> {
    const rows = await this.db.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true }
    });

    const counts: ProfileOutboxStatusCounts = {
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
      deadLetter: 0
    };

    for (const row of rows) {
      switch (row.status) {
        case OutboxStatus.PENDING:
          counts.pending = row._count._all;
          break;
        case OutboxStatus.PROCESSING:
          counts.processing = row._count._all;
          break;
        case OutboxStatus.PUBLISHED:
          counts.published = row._count._all;
          break;
        case OutboxStatus.FAILED:
          counts.failed = row._count._all;
          break;
        case OutboxStatus.DEAD_LETTER:
          counts.deadLetter = row._count._all;
          break;
        default:
          break;
      }
    }

    return counts;
  }
}

export class PrismaProfileTransactionRunner implements ProfileTransactionPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async run<T>(callback: (ports: ProfileMutationPorts) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) =>
      callback({
        users: new PrismaUserRepository(tx),
        follows: new PrismaFollowRepository(tx),
        eventPublisher: new PrismaProfileOutboxEventPublisher(tx)
      })
    );
  }
}

function cryptoSuffix(): string {
  return deriveHandle(Math.random().toString(36)).slice(0, 6);
}
