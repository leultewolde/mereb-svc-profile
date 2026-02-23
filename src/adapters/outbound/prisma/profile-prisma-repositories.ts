import type { IntegrationEventEnvelope } from '@mereb/shared-packages';
import type {
  EventPublisherPort,
  FollowRepositoryPort,
  ProfileMutationPorts,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
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
        publishedAt: null
      }
    });
  }
}

export class PrismaProfileTransactionRunner implements ProfileTransactionPort {
  async run<T>(callback: (ports: ProfileMutationPorts) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) =>
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
