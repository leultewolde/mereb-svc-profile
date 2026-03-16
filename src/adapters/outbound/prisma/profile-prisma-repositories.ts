import type { IntegrationEventEnvelope } from '@mereb/shared-packages';
import type {
  AdminUserCursor,
  EventPublisherPort,
  FollowRepositoryPort,
  ProfileMutationPorts,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
  UserConnectionRecord,
  UserSearchConnectionRecord,
  UserSearchCursor,
  UserFollowCursor,
  UserRepositoryPort
} from '../../../application/profile/ports.js';
import type { ProfileIntegrationEventRequest } from '../../../contracts/profile-events.js';
import {
  buildBootstrapUserDraft,
  buildProfileUpsertCreate,
  deriveHandle,
  type AdminUserRecord,
  type AdminUserStatus,
  type BootstrapUserDraft,
  type UpdateProfilePatch,
  type UserProfileRecord
} from '../../../domain/profile/user-profile.js';
import { prisma } from '../../../prisma.js';
import {
  OutboxStatus,
  Prisma,
  type PrismaClient,
  UserStatus
} from '../../../../generated/client/index.js';

type ProfilePrismaDb = PrismaClient | Prisma.TransactionClient;
type UserSearchRow = {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
  matchScore: number;
};

type BootstrapUserInsertRow = {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
};

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

function toAdminUserRecord(input: {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
  status: UserStatus;
  deactivatedAt: Date | null;
}): AdminUserRecord {
  return {
    ...toUserRecord(input),
    status: input.status,
    deactivatedAt: input.deactivatedAt
  };
}

function normalizeUserSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function toUserSearchConnectionRecord(input: UserSearchRow): UserSearchConnectionRecord {
  return {
    user: toUserRecord(input),
    matchScore: Number(input.matchScore)
  };
}

function buildUserSearchScoreSql(query: string): Prisma.Sql {
  const exact = query;
  const prefix = `${query}%`;
  const contains = `%${query}%`;

  return Prisma.sql`
    CASE
      WHEN LOWER("handle") = ${exact} THEN 0
      WHEN LOWER("handle") LIKE ${prefix} THEN 1
      WHEN LOWER("displayName") = ${exact} THEN 2
      WHEN LOWER("displayName") LIKE ${prefix} THEN 3
      WHEN LOWER("handle") LIKE ${contains} THEN 4
      WHEN LOWER("displayName") LIKE ${contains} THEN 5
      ELSE 6
    END
  `;
}

function buildUserSearchCursorSql(cursor: UserSearchCursor | undefined): Prisma.Sql {
  if (!cursor) {
    return Prisma.empty;
  }

  return Prisma.sql`
    AND (
      "matchScore" > ${cursor.matchScore}
      OR ("matchScore" = ${cursor.matchScore} AND "createdAt" < ${cursor.createdAt})
      OR (
        "matchScore" = ${cursor.matchScore}
        AND "createdAt" = ${cursor.createdAt}
        AND "handle" > ${cursor.handle}
      )
      OR (
        "matchScore" = ${cursor.matchScore}
        AND "createdAt" = ${cursor.createdAt}
        AND "handle" = ${cursor.handle}
        AND "id" > ${cursor.userId}
      )
    )
  `;
}

function appendUniqueHandleSuffix(handle: string): string {
  const suffix = cryptoSuffix();
  const maxBaseLength = Math.max(1, 32 - suffix.length - 1);
  return `${handle.slice(0, maxBaseLength)}_${suffix}`.slice(0, 32);
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

function adminUserCursorWhere(cursor: AdminUserCursor | undefined): Prisma.UserWhereInput | undefined {
  if (!cursor) {
    return undefined;
  }
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        id: { lt: cursor.userId }
      }
    ]
  };
}

export class PrismaUserRepository implements UserRepositoryPort, ProfileReadRepositoryPort {
  constructor(private readonly db: ProfilePrismaDb = prisma) {}

  private async insertBootstrapUserIfAvailable(input: {
    id: string;
    handle: string;
    displayName: string;
    bio: string | null;
    avatarKey: string | null;
  }): Promise<UserProfileRecord | null> {
    const timestamp = new Date();
    const rows = await this.db.$queryRaw<BootstrapUserInsertRow[]>(Prisma.sql`
      INSERT INTO "User" (
        "id",
        "handle",
        "displayName",
        "bio",
        "avatarKey",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${input.id},
        ${input.handle},
        ${input.displayName},
        ${input.bio},
        ${input.avatarKey},
        ${timestamp},
        ${timestamp}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        "id",
        "handle",
        "displayName",
        "bio",
        "avatarKey",
        "createdAt"
    `);

    const created = rows[0];
    return created ? toUserRecord(created) : null;
  }

  async findById(id: string): Promise<UserProfileRecord | null> {
    const user = await this.db.user.findFirst({
      where: {
        id,
        status: UserStatus.ACTIVE
      }
    });
    return user ? toUserRecord(user) : null;
  }

  async findByHandle(handle: string): Promise<UserProfileRecord | null> {
    const user = await this.db.user.findFirst({
      where: {
        handle,
        status: UserStatus.ACTIVE
      }
    });
    return user ? toUserRecord(user) : null;
  }

  async findAdminById(id: string): Promise<AdminUserRecord | null> {
    const user = await this.db.user.findUnique({ where: { id } });
    return user ? toAdminUserRecord(user) : null;
  }

  async searchUsers(input: { viewerId?: string; query: string; limit: number }): Promise<UserProfileRecord[]> {
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
    const normalizedQuery = normalizeUserSearchText(input.query);
    if (!normalizedQuery) {
      return [];
    }

    const scoreSql = buildUserSearchScoreSql(normalizedQuery);
    const rows = await this.db.$queryRaw<UserSearchRow[]>(Prisma.sql`
      WITH ranked_users AS (
        SELECT
          "id",
          "handle",
          "displayName",
          "bio",
          "avatarKey",
          "createdAt",
          ${scoreSql} AS "matchScore"
        FROM "User"
        WHERE
          "status" = 'ACTIVE'
          ${input.viewerId ? Prisma.sql`AND "id" <> ${input.viewerId}` : Prisma.empty}
          AND (
            LOWER("handle") LIKE ${`%${normalizedQuery}%`}
            OR LOWER("displayName") LIKE ${`%${normalizedQuery}%`}
          )
      )
      SELECT
        "id",
        "handle",
        "displayName",
        "bio",
        "avatarKey",
        "createdAt",
        "matchScore"
      FROM ranked_users
      WHERE "matchScore" < 6
      ${buildUserSearchCursorSql(input.cursor)}
      ORDER BY "matchScore" ASC, "createdAt" DESC, "handle" ASC, "id" ASC
      LIMIT ${input.take}
    `);

    return rows.map(toUserSearchConnectionRecord);
  }

  async findOrCreateWithFallback(input: BootstrapUserDraft): Promise<UserProfileRecord> {
    const existing = await this.db.user.findUnique({ where: { id: input.id } });
    if (existing) {
      return toUserRecord(existing);
    }

    const draft = buildBootstrapUserDraft(input);
    let candidateHandle = draft.handle;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const created = await this.insertBootstrapUserIfAvailable({
        ...draft,
        handle: candidateHandle
      });

      if (created) {
        return created;
      }

      const current = await this.db.user.findUnique({ where: { id: input.id } });
      if (current) {
        return toUserRecord(current);
      }

      candidateHandle = appendUniqueHandleSuffix(draft.handle);
    }

    throw new Error(`Failed to allocate a unique handle for user ${input.id}`);
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
        status: UserStatus.ACTIVE,
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

  async updateAdminStatus(input: {
    userId: string;
    status: AdminUserStatus;
  }): Promise<AdminUserRecord | null> {
    try {
      const updated = await this.db.user.update({
        where: { id: input.userId },
        data: {
          status: input.status,
          deactivatedAt: input.status === 'DEACTIVATED' ? new Date() : null
        }
      });
      return toAdminUserRecord(updated);
    } catch (error) {
      if (isPrismaCode(error, 'P2025')) {
        return null;
      }
      throw error;
    }
  }

  async countUsersCreatedSince(since: Date): Promise<number> {
    return this.db.user.count({
      where: {
        createdAt: { gte: since }
      }
    });
  }

  async listRecentUsers(limit: number): Promise<AdminUserRecord[]> {
    const users = await this.db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    return users.map(toAdminUserRecord);
  }

  async listAdminUsers(input: {
    query?: string;
    status?: AdminUserStatus;
    cursor?: AdminUserCursor;
    take: number;
  }): Promise<AdminUserRecord[]> {
    const normalizedQuery = normalizeUserSearchText(input.query ?? '');
    const users = await this.db.user.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(normalizedQuery
          ? {
              OR: [
                { id: { contains: normalizedQuery, mode: 'insensitive' } },
                { handle: { contains: normalizedQuery, mode: 'insensitive' } },
                { displayName: { contains: normalizedQuery, mode: 'insensitive' } }
              ]
            }
          : {}),
        ...adminUserCursorWhere(input.cursor)
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.take
    });

    return users.map(toAdminUserRecord);
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
        followingId: userId,
        follower: {
          is: {
            status: UserStatus.ACTIVE
          }
        }
      }
    });
  }

  async countFollowing(userId: string): Promise<number> {
    return this.db.follow.count({
      where: {
        followerId: userId,
        following: {
          is: {
            status: UserStatus.ACTIVE
          }
        }
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
        follower: {
          is: {
            status: UserStatus.ACTIVE
          }
        },
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
        following: {
          is: {
            status: UserStatus.ACTIVE
          }
        },
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
