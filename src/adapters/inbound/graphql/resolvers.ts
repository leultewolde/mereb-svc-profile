import type { IResolvers } from '@graphql-tools/utils';
import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import type { GraphQLContext } from '../../../context.js';
import {
  AuthenticationRequiredError,
  CannotFollowSelfError,
  CannotUnfollowSelfError,
  InvalidMediaAssetError
} from '../../../domain/profile/errors.js';
import type { UserProfileRecord } from '../../../domain/profile/user-profile.js';
import type { ProfileApplicationModule } from '../../../application/profile/use-cases.js';
import type { ExecutionContext } from '../../../application/profile/context.js';

type UserReference = { id: string };

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

function toExecutionContext(ctx: GraphQLContext): ExecutionContext {
  return ctx.userId
    ? {
        principal: { userId: ctx.userId },
        identity: ctx.identity
      }
    : {};
}

function collapseNameParts(parts: Array<string | undefined>): string | undefined {
  const value = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim();
  return value.length > 0 ? value : undefined;
}

function deriveDisplayName(ctx: GraphQLContext): string | undefined {
  return (
    ctx.identity?.name?.trim() ||
    collapseNameParts([ctx.identity?.givenName, ctx.identity?.familyName]) ||
    ctx.identity?.preferredUsername?.trim() ||
    ctx.identity?.email?.trim()
  );
}

function derivePreferredHandle(ctx: GraphQLContext): string | undefined {
  return ctx.identity?.preferredUsername?.trim() || ctx.identity?.email?.trim();
}

async function ensureViewerBootstrapped(
  profile: ProfileApplicationModule,
  ctx: GraphQLContext
): Promise<void> {
  if (!ctx.userId) {
    return;
  }
  await profile.commands.bootstrapUser.execute({
    id: ctx.userId,
    preferredHandle: derivePreferredHandle(ctx) ?? ctx.userId,
    displayName: deriveDisplayName(ctx) ?? ctx.userId,
    bio: null,
    avatarKey: null
  });
}

function toGraphQLError(error: unknown): never {
  if (error instanceof AuthenticationRequiredError) {
    throw new Error('UNAUTHENTICATED');
  }
  if (error instanceof CannotFollowSelfError) {
    throw new Error('CANNOT_FOLLOW_SELF');
  }
  if (error instanceof CannotUnfollowSelfError) {
    throw new Error('CANNOT_UNFOLLOW_SELF');
  }
  if (error instanceof InvalidMediaAssetError) {
    throw new Error(error.code);
  }

  throw error;
}

export function createResolvers(
  profile: ProfileApplicationModule
): IResolvers<unknown, GraphQLContext> {
  const resolveUserReference = async (ref: UserReference) =>
    profile.queries.resolveUserReference.execute({ id: ref.id });

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
      followers: (user: unknown, args: { after?: string; limit?: number }) =>
        profile.queries.getFollowersConnection.execute({
          userId: (user as UserProfileRecord).id,
          after: args.after,
          limit: args.limit
        }),
      following: (user: unknown, args: { after?: string; limit?: number }) =>
        profile.queries.getFollowingConnection.execute({
          userId: (user as UserProfileRecord).id,
          after: args.after,
          limit: args.limit
        }),
      avatarUrl: (user: unknown) =>
        profile.services.avatarUrlResolver.resolve(
          (user as UserProfileRecord).avatarKey
        ),
      followersCount: (user: unknown) =>
        profile.queries.getFollowersCount.execute({
          userId: (user as UserProfileRecord).id
        }),
      followingCount: (user: unknown) =>
        profile.queries.getFollowingCount.execute({
          userId: (user as UserProfileRecord).id
        }),
      followedByMe: (user: unknown, _args: unknown, ctx: GraphQLContext) =>
        profile.queries.getFollowedByViewer.execute({
          viewerId: ctx.userId,
          targetUserId: (user as UserProfileRecord).id
        }),
      createdAt: (user: unknown) =>
        (user as UserProfileRecord).createdAt.toISOString()
    },
    Query: {
      me: async (_source: unknown, _args: unknown, ctx: GraphQLContext) => {
        await ensureViewerBootstrapped(profile, ctx);
        return profile.queries.getMe.execute(toExecutionContext(ctx));
      },
      userByHandle: (_source: unknown, args: { handle: string }) =>
        profile.queries.getUserByHandle.execute({ handle: args.handle }),
      discoverUsers: (_source: unknown, args: { limit?: number }, ctx: GraphQLContext) =>
        profile.queries.discoverUsers.execute({
          viewerId: ctx.userId,
          limit: args.limit
        }),
      adminUserMetrics: () => profile.queries.getAdminUserMetrics.execute(),
      adminRecentUsers: (_source: unknown, args: { limit?: number }) =>
        profile.queries.getAdminRecentUsers.execute({ limit: args.limit }),
      _entities: async (
        _source: unknown,
        args: { representations: Array<{ __typename?: string }> }
      ) =>
        Promise.all(
          args.representations.map(async (representation) => {
            if (representation.__typename === 'User') {
              return resolveUserReference(representation as UserReference);
            }
            return null;
          })
        )
    },
    Mutation: {
      updateProfile: async (
        _source: unknown,
        args: Partial<{
          displayName: string;
          bio: string | null;
          avatarKey: string | null;
          avatarAssetId: string | null;
        }>,
        ctx: GraphQLContext
      ) => {
        try {
          return await profile.commands.updateProfile.execute(
            {
              ...(args.displayName === undefined
                ? {}
                : { displayName: args.displayName }),
              ...(args.bio === undefined ? {} : { bio: args.bio }),
              ...(args.avatarKey === undefined
                ? {}
                : { avatarKey: args.avatarKey }),
              ...(args.avatarAssetId === undefined
                ? {}
                : { avatarAssetId: args.avatarAssetId })
            },
            toExecutionContext(ctx)
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      followUser: async (
        _source: unknown,
        args: { userId: string },
        ctx: GraphQLContext
      ) => {
        try {
          return await profile.commands.followUser.execute(
            { userId: args.userId },
            toExecutionContext(ctx)
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      unfollowUser: async (
        _source: unknown,
        args: { userId: string },
        ctx: GraphQLContext
      ) => {
        try {
          return await profile.commands.unfollowUser.execute(
            { userId: args.userId },
            toExecutionContext(ctx)
          );
        } catch (error) {
          toGraphQLError(error);
        }
      }
    }
  } as IResolvers<unknown, GraphQLContext>;
}
