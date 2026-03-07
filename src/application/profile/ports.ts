import type { IntegrationEventEnvelope } from '@mereb/shared-packages';
import type {
  BootstrapUserDraft,
  UpdateProfilePatch,
  UserProfileRecord
} from '../../domain/profile/user-profile.js';
import type { ProfileIntegrationEventRequest } from '../../contracts/profile-events.js';

export interface AdminUserMetrics {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
}

export interface UserFollowCursor {
  createdAt: Date;
  userId: string;
}

export interface UserConnectionRecord {
  user: UserProfileRecord;
  followedAt: Date;
}

export interface UserConnectionPage {
  edges: Array<{
    node: UserProfileRecord;
    cursor: string;
  }>;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export interface UserRepositoryPort {
  findById(id: string): Promise<UserProfileRecord | null>;
  findByHandle(handle: string): Promise<UserProfileRecord | null>;
  findOrCreateWithFallback(input: BootstrapUserDraft): Promise<UserProfileRecord>;
  upsertProfile(userId: string, patch: UpdateProfilePatch): Promise<UserProfileRecord>;
  listDiscoverableUsers(input: { viewerId: string; limit: number }): Promise<UserProfileRecord[]>;
}

export interface FollowRepositoryPort {
  upsertFollow(followerId: string, followingId: string): Promise<void>;
  deleteFollowIfExists(followerId: string, followingId: string): Promise<void>;
  countFollowers(userId: string): Promise<number>;
  countFollowing(userId: string): Promise<number>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  listFollowers(input: {
    userId: string;
    cursor?: UserFollowCursor;
    take: number;
  }): Promise<UserConnectionRecord[]>;
  listFollowing(input: {
    userId: string;
    cursor?: UserFollowCursor;
    take: number;
  }): Promise<UserConnectionRecord[]>;
}

export interface ProfileReadRepositoryPort {
  countUsers(): Promise<number>;
  countUsersCreatedSince(since: Date): Promise<number>;
  listRecentUsers(limit: number): Promise<UserProfileRecord[]>;
}

export interface MediaUrlSignerPort {
  signMediaUrl(key: string): string;
}

export interface MediaAssetResolverPort {
  resolveOwnedReadyAsset(input: {
    assetId: string;
    userId: string;
  }): Promise<{ key: string }>;
}

export interface EventPublisherPort {
  publish<TData>(
    request: ProfileIntegrationEventRequest<TData>,
    envelope: IntegrationEventEnvelope<TData>
  ): Promise<void>;
}

export interface ProfileMutationPorts {
  users: UserRepositoryPort;
  follows: FollowRepositoryPort;
  eventPublisher: EventPublisherPort;
}

export interface ProfileTransactionPort {
  run<T>(callback: (ports: ProfileMutationPorts) => Promise<T>): Promise<T>;
}
