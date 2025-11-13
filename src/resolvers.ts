import type { IResolvers } from '@graphql-tools/utils';
import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import { randomUUID } from 'node:crypto';
import { signMediaUrl } from '@mereb/shared-packages';
import { prisma } from './prisma.js';
import type { GraphQLContext } from './context.js';

type User = {
  id: string;
  handle: string;
  displayName: string;
  bio?: string | null;
  avatarKey?: string | null;
  createdAt: Date;
};

type UserReference = { id: string };

function deriveHandle(source: string) {
  const normalised = source
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
  if (normalised.length > 2) {
    return normalised;
  }
  return `user_${randomUUID().slice(0, 8)}`;
}

function parseAnyLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.LIST:
      return ast.values.map((valueNode) => parseAnyLiteral(valueNode));
    case Kind.OBJECT: {
      const value: Record<string, unknown> = {};
      for (const field of ast.fields) {
        value[field.name.value] = parseAnyLiteral(field.value);
      }
      return value;
    }
    default:
      return null;
  }
}

const AnyScalar = new GraphQLScalarType({
  name: '_Any',
  description: 'Federation scalar that can represent any JSON value.',
  serialize: (value: unknown) => value,
  parseValue: (value: unknown) => value,
  parseLiteral: (ast) => parseAnyLiteral(ast)
});

export function createResolvers(): IResolvers<any, GraphQLContext> {
  const resolveUserReference = async (ref: UserReference) => {
    const { id } = ref;
    const existing = await prisma.user.findUnique({ where: { id } });
    if (existing) {
      return existing;
    }

    const fallbackHandle = deriveHandle(id);

    try {
      return await prisma.user.create({
        data: {
          id,
          handle: fallbackHandle,
          displayName: fallbackHandle,
          bio: null,
          avatarKey: null
        }
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        const uniqueHandle = `${fallbackHandle}_${randomUUID().slice(0, 6)}`;
        return prisma.user.create({
          data: {
            id,
            handle: uniqueHandle,
            displayName: uniqueHandle,
            bio: null,
            avatarKey: null
          }
        });
      }

      throw error;
    }
  };

  return {
    _Any: AnyScalar,
    _Entity: {
      __resolveType: (entity: unknown) => {
        if (entity && typeof entity === 'object' && 'handle' in entity) {
          return 'User';
        }
        return null;
      }
    },
    User: {
      __resolveReference: async (ref: unknown) =>
        resolveUserReference(ref as UserReference),
      avatarUrl: (user: unknown) => {
        const { avatarKey } = user as User;
        return avatarKey ? signMediaUrl(avatarKey) : null;
      },
      followersCount: (user: unknown) =>
        prisma.follow.count({
          where: { followingId: (user as User).id }
        }),
      followingCount: (user: unknown) =>
        prisma.follow.count({
          where: { followerId: (user as User).id }
        }),
      followedByMe: async (
        user: unknown,
        _args: unknown,
        ctx: GraphQLContext
      ) => {
        const viewerId = ctx.userId;
        const targetId = (user as User).id;
        if (!viewerId || viewerId === targetId) {
          return false;
        }

        const existing = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: viewerId,
              followingId: targetId
            }
          }
        });

        return Boolean(existing);
      },
      createdAt: (user: unknown) => {
        const { createdAt } = user as User;
        return createdAt instanceof Date
          ? createdAt.toISOString()
          : new Date(createdAt).toISOString();
      }
    },
    Query: {
      me: async (_source: unknown, _args: unknown, ctx: GraphQLContext) =>
        ctx.userId
          ? prisma.user.findUnique({ where: { id: ctx.userId } })
          : null,
      userByHandle: async (
        _source: unknown,
        args: { handle: string }
      ) => prisma.user.findUnique({ where: { handle: args.handle } }),
      adminUserMetrics: async () => {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay();
        const diff = (day === 0 ? 6 : day - 1);
        startOfWeek.setDate(startOfWeek.getDate() - diff);
        startOfWeek.setHours(0, 0, 0, 0);

        const [totalUsers, newUsersToday, newUsersThisWeek] = await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
          prisma.user.count({ where: { createdAt: { gte: startOfWeek } } })
        ]);

        return {
          totalUsers,
          newUsersToday,
          newUsersThisWeek
        };
      },
      adminRecentUsers: async (
        _source: unknown,
        args: { limit?: number }
      ) => {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        return prisma.user.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit
        });
      },
      _entities: async (
        _source: unknown,
        args: { representations: Array<{ __typename?: string }> }
      ) => {
        const results = await Promise.all(
          args.representations.map(async (representation) => {
            switch (representation.__typename) {
              case 'User':
                return resolveUserReference(representation as UserReference);
              default:
                return null;
            }
          })
        );
        return results;
      }
    },
    Mutation: {
      updateProfile: async (
        _source: unknown,
        args: Partial<{ displayName: string; bio: string; avatarKey: string }>,
        ctx: GraphQLContext
      ) => {
        if (!ctx.userId) {
          throw new Error('UNAUTHENTICATED');
        }

        return prisma.user.upsert({
          where: { id: ctx.userId },
          update: {
            ...(args.displayName ? { displayName: args.displayName } : {}),
            ...(args.bio !== undefined ? { bio: args.bio } : {}),
            ...(args.avatarKey !== undefined
              ? { avatarKey: args.avatarKey }
              : {})
          },
          create: {
            id: ctx.userId,
            handle: deriveHandle(args.displayName ?? ctx.userId),
            displayName: args.displayName ?? 'New User',
            bio: args.bio,
            avatarKey: args.avatarKey ?? null
          }
        });
      },
      followUser: async (
        _source: unknown,
        args: { userId: string },
        ctx: GraphQLContext
      ) => {
        if (!ctx.userId) {
          throw new Error('UNAUTHENTICATED');
        }

        const targetId = args.userId;
        if (ctx.userId === targetId) {
          throw new Error('CANNOT_FOLLOW_SELF');
        }

        const user = await resolveUserReference({ id: targetId });

        await prisma.follow.upsert({
          where: {
            followerId_followingId: {
              followerId: ctx.userId,
              followingId: targetId
            }
          },
          update: {},
          create: {
            followerId: ctx.userId,
            followingId: targetId
          }
        });

        return user;
      },
      unfollowUser: async (
        _source: unknown,
        args: { userId: string },
        ctx: GraphQLContext
      ) => {
        if (!ctx.userId) {
          throw new Error('UNAUTHENTICATED');
        }

        const targetId = args.userId;
        if (ctx.userId === targetId) {
          throw new Error('CANNOT_UNFOLLOW_SELF');
        }

        await prisma.follow
          .delete({
            where: {
              followerId_followingId: {
                followerId: ctx.userId,
                followingId: targetId
              }
            }
          })
          .catch((error) => {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              (error as { code?: string }).code !== 'P2025'
            ) {
              throw error;
            }
          });

        return resolveUserReference({ id: targetId });
      }
    }
  } as IResolvers<any, GraphQLContext>;
}
