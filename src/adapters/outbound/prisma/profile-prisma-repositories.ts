import type {
  FollowRepositoryPort,
  ProfileReadRepositoryPort,
  UserRepositoryPort
} from '../../../application/profile/ports.js';
import {
  buildBootstrapUserDraft,
  buildProfileUpsertCreate,
  deriveHandle,
  type BootstrapUserDraft,
  type UpdateProfilePatch,
  type UserProfileRecord
} from '../../../domain/profile/user-profile.js';
import { prisma } from '../../../prisma.js';

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

export class PrismaUserRepository
  implements UserRepositoryPort, ProfileReadRepositoryPort
{
  async findById(id: string): Promise<UserProfileRecord | null> {
    const user = await prisma.user.findUnique({ where: { id } });
    return user ? toUserRecord(user) : null;
  }

  async findByHandle(handle: string): Promise<UserProfileRecord | null> {
    const user = await prisma.user.findUnique({ where: { handle } });
    return user ? toUserRecord(user) : null;
  }

  async findOrCreateWithFallback(input: BootstrapUserDraft): Promise<UserProfileRecord> {
    const existing = await prisma.user.findUnique({ where: { id: input.id } });
    if (existing) {
      return toUserRecord(existing);
    }

    const draft = buildBootstrapUserDraft(input);

    try {
      const created = await prisma.user.create({ data: draft });
      return toUserRecord(created);
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) {
        throw error;
      }

      const uniqueHandle = `${draft.handle}_${cryptoSuffix()}`.slice(0, 32);
      const created = await prisma.user.create({
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

  async upsertProfile(
    userId: string,
    patch: UpdateProfilePatch
  ): Promise<UserProfileRecord> {
    const updated = await prisma.user.upsert({
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
    return prisma.user.count();
  }

  async countUsersCreatedSince(since: Date): Promise<number> {
    return prisma.user.count({
      where: {
        createdAt: { gte: since }
      }
    });
  }

  async listRecentUsers(limit: number): Promise<UserProfileRecord[]> {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    return users.map(toUserRecord);
  }
}

export class PrismaFollowRepository implements FollowRepositoryPort {
  async upsertFollow(followerId: string, followingId: string): Promise<void> {
    await prisma.follow.upsert({
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

  async deleteFollowIfExists(
    followerId: string,
    followingId: string
  ): Promise<void> {
    await prisma.follow
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
    return prisma.follow.count({
      where: {
        followingId: userId
      }
    });
  }

  async countFollowing(userId: string): Promise<number> {
    return prisma.follow.count({
      where: {
        followerId: userId
      }
    });
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const existing = await prisma.follow.findUnique({
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

function cryptoSuffix(): string {
  return deriveHandle(Math.random().toString(36)).slice(0, 6);
}
