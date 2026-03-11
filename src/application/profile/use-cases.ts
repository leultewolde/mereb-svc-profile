import {
  createIntegrationEventEnvelope,
  hasAdminReadAccess,
  hasFullAdminAccess,
  type IntegrationEventEnvelope
} from '@mereb/shared-packages';
import { PROFILE_EVENT_TOPICS, type ProfileIntegrationEventRequest } from '../../contracts/profile-events.js';
import { assertCanFollow, assertCanUnfollow } from '../../domain/profile/follow-relationship.js';
import {
  profileUpdatedEvent,
  userBootstrappedEvent,
  userFollowedEvent,
  userUnfollowedEvent
} from '../../domain/profile/events.js';
import {
  AuthenticationRequiredError,
  AuthorizationRequiredError,
  CannotFollowSelfError,
  CannotUnfollowSelfError,
  InvalidMediaAssetError,
  ProfileUserNotFoundError
} from '../../domain/profile/errors.js';
import type { ExecutionContext } from './context.js';
import type {
  AdminUserConnectionPage,
  AdminUserCursor,
  AdminUserMetrics,
  EventPublisherPort,
  FollowRepositoryPort,
  MediaAssetResolverPort,
  MediaUrlSignerPort,
  ProfileMutationPorts,
  ProfileReadRepositoryPort,
  ProfileTransactionPort,
  UserConnectionPage,
  UserConnectionRecord,
  UserFollowCursor,
  UserRepositoryPort
} from './ports.js';
import type {
  AdminUserRecord,
  BootstrapUserDraft,
  UpdateProfilePatch,
  UserProfileRecord
} from '../../domain/profile/user-profile.js';

interface ProfileUseCaseDeps {
  users: UserRepositoryPort;
  follows: FollowRepositoryPort;
  profileRead: ProfileReadRepositoryPort;
  eventPublisher: EventPublisherPort;
  mediaUrlSigner: MediaUrlSignerPort;
  mediaAssetResolver?: MediaAssetResolverPort;
  eventProducerName: string;
  transactionRunner?: ProfileTransactionPort;
}

function buildEnvelope<TData>(
  producer: string,
  request: ProfileIntegrationEventRequest<TData>,
  occurredAt?: Date
): IntegrationEventEnvelope<TData> {
  return createIntegrationEventEnvelope({
    eventType: request.eventType,
    producer,
    data: request.data,
    occurredAt,
    correlationId: request.correlationId,
    causationId: request.causationId,
    tenantId: request.tenantId
  });
}

async function publishBestEffort<TData>(
  deps: Pick<ProfileUseCaseDeps, 'eventProducerName'> & { eventPublisher: EventPublisherPort },
  request: ProfileIntegrationEventRequest<TData>,
  occurredAt?: Date
) {
  const envelope = buildEnvelope(deps.eventProducerName, request, occurredAt);
  await deps.eventPublisher.publish(request, envelope);
}

function getDefaultMutationPorts(
  deps: ProfileUseCaseDeps
): ProfileMutationPorts {
  return {
    users: deps.users,
    follows: deps.follows,
    eventPublisher: deps.eventPublisher
  };
}

async function runInMutationTransaction<T>(
  deps: ProfileUseCaseDeps,
  callback: (ports: ProfileMutationPorts) => Promise<T>
): Promise<T> {
  if (!deps.transactionRunner) {
    return callback(getDefaultMutationPorts(deps));
  }
  return deps.transactionRunner.run(callback);
}

function toContextUserId(ctx: ExecutionContext): string {
  const userId = ctx.principal?.userId;
  if (!userId) {
    throw new AuthenticationRequiredError();
  }
  return userId;
}

function requireAdminReadAccessOrThrow(ctx: ExecutionContext): string[] {
  const roles = ctx.principal?.roles ?? [];
  if (!hasAdminReadAccess(roles)) {
    throw new AuthorizationRequiredError();
  }
  return roles;
}

function requireFullAdminAccessOrThrow(ctx: ExecutionContext): string[] {
  const roles = ctx.principal?.roles ?? [];
  if (!hasFullAdminAccess(roles)) {
    throw new AuthorizationRequiredError();
  }
  return roles;
}

function getStartOfToday(now = new Date()): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getStartOfWeek(now = new Date()): Date {
  const start = new Date(now);
  const day = start.getDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function normalizeLimit(limit: number | undefined, fallback: number, max = 50): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}

function normalizeUserSearchQuery(query: string): string {
  return query.trim().replace(/^@/, '');
}

function encodeUserFollowCursor(input: UserFollowCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt.toISOString(),
      userId: input.userId
    }),
    'utf8'
  ).toString('base64url');
}

function decodeUserFollowCursor(encoded?: string): UserFollowCursor | undefined {
  if (!encoded) {
    return undefined;
  }
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      createdAt?: string;
      userId?: string;
    };
    if (!raw.createdAt || !raw.userId) {
      return undefined;
    }
    const createdAt = new Date(raw.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return undefined;
    }
    return {
      createdAt,
      userId: raw.userId
    };
  } catch {
    return undefined;
  }
}

function encodeAdminUserCursor(input: AdminUserCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt.toISOString(),
      userId: input.userId
    }),
    'utf8'
  ).toString('base64url');
}

function decodeAdminUserCursor(encoded?: string): AdminUserCursor | undefined {
  if (!encoded) {
    return undefined;
  }
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      createdAt?: string;
      userId?: string;
    };
    if (!raw.createdAt || !raw.userId) {
      return undefined;
    }
    const createdAt = new Date(raw.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return undefined;
    }
    return {
      createdAt,
      userId: raw.userId
    };
  } catch {
    return undefined;
  }
}

function toUserConnectionPage(rows: UserConnectionRecord[], limit: number): UserConnectionPage {
  const edges = rows.slice(0, limit).map((row) => ({
    node: row.user,
    cursor: encodeUserFollowCursor({
      createdAt: row.followedAt,
      userId: row.user.id
    })
  }));
  return {
    edges,
    pageInfo: {
      endCursor: edges.at(-1)?.cursor ?? null,
      hasNextPage: rows.length > limit
    }
  };
}

function toAdminUserConnectionPage(rows: AdminUserRecord[], limit: number): AdminUserConnectionPage {
  const edges = rows.slice(0, limit).map((row) => ({
    node: row,
    cursor: encodeAdminUserCursor({
      createdAt: row.createdAt,
      userId: row.id
    })
  }));

  return {
    edges,
    pageInfo: {
      endCursor: edges.at(-1)?.cursor ?? null,
      hasNextPage: rows.length > limit
    }
  };
}

export class BootstrapUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(input: BootstrapUserDraft): Promise<{ created: boolean; userId: string; handle?: string }> {
    return runInMutationTransaction(this.deps, async (ports) => {
      const existing = await ports.users.findById(input.id);
      if (existing) {
        return { created: false, userId: existing.id };
      }

      const created = await ports.users.findOrCreateWithFallback(input);
      const domainEvent = userBootstrappedEvent(created.id, created.handle);
      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userBootstrapped,
          eventType: PROFILE_EVENT_TOPICS.userBootstrapped,
          key: created.id,
          data: {
            user_id: created.id,
            handle: created.handle
          }
        },
        domainEvent.occurredAt
      );

      return { created: true, userId: created.id, handle: created.handle };
    });
  }
}

export class UpdateProfileUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  private async resolveAvatarKey(
    userId: string,
    input: {
      avatarKey?: string | null;
      avatarAssetId?: string | null;
    }
  ): Promise<string | null | undefined> {
    if (input.avatarAssetId === undefined) {
      return input.avatarKey;
    }

    if (input.avatarAssetId === null) {
      return null;
    }

    if (!this.deps.mediaAssetResolver) {
      throw new InvalidMediaAssetError('Media resolver is not configured');
    }
    const resolved = await this.deps.mediaAssetResolver.resolveOwnedReadyAsset({
      assetId: input.avatarAssetId,
      userId
    });
    return resolved.key;
  }

  async execute(
    patch: UpdateProfilePatch & { avatarAssetId?: string | null },
    ctx: ExecutionContext
  ): Promise<UserProfileRecord> {
    const userId = toContextUserId(ctx);
    const resolvedAvatarKey = await this.resolveAvatarKey(userId, {
      avatarKey: patch.avatarKey,
      avatarAssetId: patch.avatarAssetId
    });

    const upsertPatch: UpdateProfilePatch = {
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.bio === undefined ? {} : { bio: patch.bio }),
      ...(resolvedAvatarKey === undefined ? {} : { avatarKey: resolvedAvatarKey })
    };

    return runInMutationTransaction(this.deps, async (ports) => {
      const updated = await ports.users.upsertProfile(userId, upsertPatch);
      const domainEvent = profileUpdatedEvent(updated.id, updated.handle);

      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userUpdated,
          eventType: PROFILE_EVENT_TOPICS.userUpdated,
          key: updated.id,
          data: {
            user_id: updated.id,
            handle: updated.handle
          },
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          tenantId: ctx.tenantId
        },
        domainEvent.occurredAt
      );

      return updated;
    });
  }
}

export class FollowUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(
    input: { userId: string },
    ctx: ExecutionContext
  ): Promise<UserProfileRecord> {
    const followerId = toContextUserId(ctx);
    const followingId = input.userId;

    try {
      assertCanFollow(followerId, followingId);
    } catch (error) {
      if (error instanceof CannotFollowSelfError) {
        throw error;
      }
      throw error;
    }

    return runInMutationTransaction(this.deps, async (ports) => {
      const user = await ports.users.findOrCreateWithFallback({
        id: followingId,
        preferredHandle: followingId,
        displayName: followingId,
        bio: null,
        avatarKey: null
      });

      await ports.follows.upsertFollow(followerId, followingId);

      const domainEvent = userFollowedEvent(followerId, followingId);
      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userFollowed,
          eventType: PROFILE_EVENT_TOPICS.userFollowed,
          key: followingId,
          data: {
            follower_id: followerId,
            following_id: followingId
          },
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          tenantId: ctx.tenantId
        },
        domainEvent.occurredAt
      );

      return user;
    });
  }
}

export class UnfollowUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(
    input: { userId: string },
    ctx: ExecutionContext
  ): Promise<UserProfileRecord> {
    const followerId = toContextUserId(ctx);
    const followingId = input.userId;

    try {
      assertCanUnfollow(followerId, followingId);
    } catch (error) {
      if (error instanceof CannotUnfollowSelfError) {
        throw error;
      }
      throw error;
    }

    return runInMutationTransaction(this.deps, async (ports) => {
      await ports.follows.deleteFollowIfExists(followerId, followingId);

      const user = await ports.users.findOrCreateWithFallback({
        id: followingId,
        preferredHandle: followingId,
        displayName: followingId,
        bio: null,
        avatarKey: null
      });

      const domainEvent = userUnfollowedEvent(followerId, followingId);
      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userUnfollowed,
          eventType: PROFILE_EVENT_TOPICS.userUnfollowed,
          key: followingId,
          data: {
            follower_id: followerId,
            following_id: followingId
          },
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          tenantId: ctx.tenantId
        },
        domainEvent.occurredAt
      );

      return user;
    });
  }
}

export class GetMeQuery {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(ctx: ExecutionContext): Promise<UserProfileRecord | null> {
    const userId = ctx.principal?.userId;
    if (!userId) {
      return null;
    }
    return this.users.findById(userId);
  }
}

export class GetUserByHandleQuery {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: { handle: string }): Promise<UserProfileRecord | null> {
    return this.users.findByHandle(input.handle);
  }
}

export class SearchUsersQuery {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: { viewerId?: string; query: string; limit?: number }): Promise<UserProfileRecord[]> {
    const query = normalizeUserSearchQuery(input.query);
    if (!query) {
      return [];
    }

    return this.users.searchUsers({
      viewerId: input.viewerId,
      query,
      limit: normalizeLimit(input.limit, 8)
    });
  }
}

export class GetAdminUserMetricsQuery {
  constructor(private readonly profileRead: ProfileReadRepositoryPort) {}

  async execute(ctx: ExecutionContext, now = new Date()): Promise<AdminUserMetrics> {
    requireAdminReadAccessOrThrow(ctx);
    const [totalUsers, newUsersToday, newUsersThisWeek] = await Promise.all([
      this.profileRead.countUsers(),
      this.profileRead.countUsersCreatedSince(getStartOfToday(now)),
      this.profileRead.countUsersCreatedSince(getStartOfWeek(now))
    ]);

    return { totalUsers, newUsersToday, newUsersThisWeek };
  }
}

export class GetAdminRecentUsersQuery {
  constructor(private readonly profileRead: ProfileReadRepositoryPort) {}

  async execute(input: { limit?: number }, ctx: ExecutionContext): Promise<AdminUserRecord[]> {
    requireAdminReadAccessOrThrow(ctx);
    return this.profileRead.listRecentUsers(normalizeLimit(input.limit, 10));
  }
}

export class GetAdminUsersQuery {
  constructor(private readonly profileRead: ProfileReadRepositoryPort) {}

  async execute(
    input: { query?: string; status?: 'ACTIVE' | 'DEACTIVATED'; after?: string; limit?: number },
    ctx: ExecutionContext
  ): Promise<AdminUserConnectionPage> {
    requireAdminReadAccessOrThrow(ctx);
    const limit = normalizeLimit(input.limit, 20);
    const rows = await this.profileRead.listAdminUsers({
      query: input.query?.trim() || undefined,
      status: input.status,
      cursor: decodeAdminUserCursor(input.after),
      take: limit + 1
    });
    return toAdminUserConnectionPage(rows, limit);
  }
}

export class AdminDeactivateUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(input: { userId: string }, ctx: ExecutionContext): Promise<AdminUserRecord> {
    requireFullAdminAccessOrThrow(ctx);

    return runInMutationTransaction(this.deps, async (ports) => {
      const updated = await ports.users.updateAdminStatus({
        userId: input.userId,
        status: 'DEACTIVATED'
      });

      if (!updated) {
        throw new ProfileUserNotFoundError();
      }

      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userDeactivated,
          eventType: PROFILE_EVENT_TOPICS.userDeactivated,
          key: updated.id,
          data: {
            user_id: updated.id
          },
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          tenantId: ctx.tenantId
        }
      );

      return updated;
    });
  }
}

export class AdminReactivateUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(input: { userId: string }, ctx: ExecutionContext): Promise<AdminUserRecord> {
    requireFullAdminAccessOrThrow(ctx);

    return runInMutationTransaction(this.deps, async (ports) => {
      const updated = await ports.users.updateAdminStatus({
        userId: input.userId,
        status: 'ACTIVE'
      });

      if (!updated) {
        throw new ProfileUserNotFoundError();
      }

      await publishBestEffort(
        { eventPublisher: ports.eventPublisher, eventProducerName: this.deps.eventProducerName },
        {
          topic: PROFILE_EVENT_TOPICS.userReactivated,
          eventType: PROFILE_EVENT_TOPICS.userReactivated,
          key: updated.id,
          data: {
            user_id: updated.id
          },
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          tenantId: ctx.tenantId
        }
      );

      return updated;
    });
  }
}

export class ResolveUserReferenceQuery {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: { id: string }): Promise<UserProfileRecord> {
    return this.users.findOrCreateWithFallback({
      id: input.id,
      preferredHandle: input.id,
      displayName: input.id,
      bio: null,
      avatarKey: null
    });
  }
}

export class GetFollowersCountQuery {
  constructor(private readonly follows: FollowRepositoryPort) {}

  async execute(input: { userId: string }): Promise<number> {
    return this.follows.countFollowers(input.userId);
  }
}

export class GetFollowingCountQuery {
  constructor(private readonly follows: FollowRepositoryPort) {}

  async execute(input: { userId: string }): Promise<number> {
    return this.follows.countFollowing(input.userId);
  }
}

export class GetFollowedByViewerQuery {
  constructor(private readonly follows: FollowRepositoryPort) {}

  async execute(input: { viewerId?: string; targetUserId: string }): Promise<boolean> {
    const { viewerId, targetUserId } = input;
    if (!viewerId || viewerId === targetUserId) {
      return false;
    }
    return this.follows.isFollowing(viewerId, targetUserId);
  }
}

export class DiscoverUsersQuery {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: { viewerId?: string; limit?: number }): Promise<UserProfileRecord[]> {
    if (!input.viewerId) {
      return [];
    }
    return this.users.listDiscoverableUsers({
      viewerId: input.viewerId,
      limit: normalizeLimit(input.limit, 8)
    });
  }
}

export class GetFollowersConnectionQuery {
  constructor(private readonly follows: FollowRepositoryPort) {}

  async execute(input: { userId: string; after?: string; limit?: number }): Promise<UserConnectionPage> {
    const limit = normalizeLimit(input.limit, 20);
    const rows = await this.follows.listFollowers({
      userId: input.userId,
      cursor: decodeUserFollowCursor(input.after),
      take: limit + 1
    });
    return toUserConnectionPage(rows, limit);
  }
}

export class GetFollowingConnectionQuery {
  constructor(private readonly follows: FollowRepositoryPort) {}

  async execute(input: { userId: string; after?: string; limit?: number }): Promise<UserConnectionPage> {
    const limit = normalizeLimit(input.limit, 20);
    const rows = await this.follows.listFollowing({
      userId: input.userId,
      cursor: decodeUserFollowCursor(input.after),
      take: limit + 1
    });
    return toUserConnectionPage(rows, limit);
  }
}

export class AvatarUrlResolver {
  constructor(private readonly media: MediaUrlSignerPort) {}

  resolve(avatarKey?: string | null): string | null {
    if (!avatarKey) {
      return null;
    }
    return this.media.signMediaUrl(avatarKey);
  }
}

export interface ProfileApplicationModule {
  commands: {
    bootstrapUser: BootstrapUserUseCase;
    updateProfile: UpdateProfileUseCase;
    followUser: FollowUserUseCase;
    unfollowUser: UnfollowUserUseCase;
    adminDeactivateUser: AdminDeactivateUserUseCase;
    adminReactivateUser: AdminReactivateUserUseCase;
  };
  queries: {
    getMe: GetMeQuery;
    getUserByHandle: GetUserByHandleQuery;
    searchUsers: SearchUsersQuery;
    discoverUsers: DiscoverUsersQuery;
    getAdminUserMetrics: GetAdminUserMetricsQuery;
    getAdminRecentUsers: GetAdminRecentUsersQuery;
    getAdminUsers: GetAdminUsersQuery;
    resolveUserReference: ResolveUserReferenceQuery;
    getFollowersCount: GetFollowersCountQuery;
    getFollowingCount: GetFollowingCountQuery;
    getFollowedByViewer: GetFollowedByViewerQuery;
    getFollowersConnection: GetFollowersConnectionQuery;
    getFollowingConnection: GetFollowingConnectionQuery;
  };
  services: {
    avatarUrlResolver: AvatarUrlResolver;
  };
}

export function createProfileApplicationModule(
  deps: ProfileUseCaseDeps
): ProfileApplicationModule {
  return {
    commands: {
      bootstrapUser: new BootstrapUserUseCase(deps),
      updateProfile: new UpdateProfileUseCase(deps),
    followUser: new FollowUserUseCase(deps),
      unfollowUser: new UnfollowUserUseCase(deps),
      adminDeactivateUser: new AdminDeactivateUserUseCase(deps),
      adminReactivateUser: new AdminReactivateUserUseCase(deps)
    },
    queries: {
      getMe: new GetMeQuery(deps.users),
      getUserByHandle: new GetUserByHandleQuery(deps.users),
      searchUsers: new SearchUsersQuery(deps.users),
      discoverUsers: new DiscoverUsersQuery(deps.users),
      getAdminUserMetrics: new GetAdminUserMetricsQuery(deps.profileRead),
      getAdminRecentUsers: new GetAdminRecentUsersQuery(deps.profileRead),
      getAdminUsers: new GetAdminUsersQuery(deps.profileRead),
      resolveUserReference: new ResolveUserReferenceQuery(deps.users),
      getFollowersCount: new GetFollowersCountQuery(deps.follows),
      getFollowingCount: new GetFollowingCountQuery(deps.follows),
      getFollowedByViewer: new GetFollowedByViewerQuery(deps.follows),
      getFollowersConnection: new GetFollowersConnectionQuery(deps.follows),
      getFollowingConnection: new GetFollowingConnectionQuery(deps.follows)
    },
    services: {
      avatarUrlResolver: new AvatarUrlResolver(deps.mediaUrlSigner)
    }
  };
}
