import {
  createIntegrationEventEnvelope,
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
  CannotFollowSelfError,
  CannotUnfollowSelfError
} from '../../domain/profile/errors.js';
import type { ExecutionContext } from './context.js';
import type {
  AdminUserMetrics,
  EventPublisherPort,
  FollowRepositoryPort,
  MediaUrlSignerPort,
  ProfileReadRepositoryPort,
  UserRepositoryPort
} from './ports.js';
import type {
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
  eventProducerName: string;
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
  deps: Pick<ProfileUseCaseDeps, 'eventPublisher' | 'eventProducerName'>,
  request: ProfileIntegrationEventRequest<TData>,
  occurredAt?: Date
) {
  const envelope = buildEnvelope(deps.eventProducerName, request, occurredAt);
  await deps.eventPublisher.publish(request, envelope);
}

function toContextUserId(ctx: ExecutionContext): string {
  const userId = ctx.principal?.userId;
  if (!userId) {
    throw new AuthenticationRequiredError();
  }
  return userId;
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

export class BootstrapUserUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(input: BootstrapUserDraft): Promise<{ created: boolean; userId: string; handle?: string }> {
    const existing = await this.deps.users.findById(input.id);
    if (existing) {
      return { created: false, userId: existing.id };
    }

    const created = await this.deps.users.findOrCreateWithFallback(input);
    const domainEvent = userBootstrappedEvent(created.id, created.handle);
    await publishBestEffort(
      this.deps,
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
  }
}

export class UpdateProfileUseCase {
  constructor(private readonly deps: ProfileUseCaseDeps) {}

  async execute(
    patch: UpdateProfilePatch,
    ctx: ExecutionContext
  ): Promise<UserProfileRecord> {
    const userId = toContextUserId(ctx);
    const updated = await this.deps.users.upsertProfile(userId, patch);
    const domainEvent = profileUpdatedEvent(updated.id, updated.handle);

    await publishBestEffort(
      this.deps,
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

    const user = await this.deps.users.findOrCreateWithFallback({
      id: followingId,
      preferredHandle: followingId,
      displayName: followingId,
      bio: null,
      avatarKey: null
    });

    await this.deps.follows.upsertFollow(followerId, followingId);

    const domainEvent = userFollowedEvent(followerId, followingId);
    await publishBestEffort(
      this.deps,
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

    await this.deps.follows.deleteFollowIfExists(followerId, followingId);

    const user = await this.deps.users.findOrCreateWithFallback({
      id: followingId,
      preferredHandle: followingId,
      displayName: followingId,
      bio: null,
      avatarKey: null
    });

    const domainEvent = userUnfollowedEvent(followerId, followingId);
    await publishBestEffort(
      this.deps,
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

export class GetAdminUserMetricsQuery {
  constructor(private readonly profileRead: ProfileReadRepositoryPort) {}

  async execute(now = new Date()): Promise<AdminUserMetrics> {
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

  async execute(input: { limit?: number }): Promise<UserProfileRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    return this.profileRead.listRecentUsers(limit);
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
  };
  queries: {
    getMe: GetMeQuery;
    getUserByHandle: GetUserByHandleQuery;
    getAdminUserMetrics: GetAdminUserMetricsQuery;
    getAdminRecentUsers: GetAdminRecentUsersQuery;
    resolveUserReference: ResolveUserReferenceQuery;
    getFollowersCount: GetFollowersCountQuery;
    getFollowingCount: GetFollowingCountQuery;
    getFollowedByViewer: GetFollowedByViewerQuery;
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
      unfollowUser: new UnfollowUserUseCase(deps)
    },
    queries: {
      getMe: new GetMeQuery(deps.users),
      getUserByHandle: new GetUserByHandleQuery(deps.users),
      getAdminUserMetrics: new GetAdminUserMetricsQuery(deps.profileRead),
      getAdminRecentUsers: new GetAdminRecentUsersQuery(deps.profileRead),
      resolveUserReference: new ResolveUserReferenceQuery(deps.users),
      getFollowersCount: new GetFollowersCountQuery(deps.follows),
      getFollowingCount: new GetFollowingCountQuery(deps.follows),
      getFollowedByViewer: new GetFollowedByViewerQuery(deps.follows)
    },
    services: {
      avatarUrlResolver: new AvatarUrlResolver(deps.mediaUrlSigner)
    }
  };
}
