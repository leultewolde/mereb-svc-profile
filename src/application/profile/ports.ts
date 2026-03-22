import type { IntegrationEventEnvelope } from '@mereb/shared-packages';
import type {
  AdminUserRecord,
  AdminUserStatus,
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

export interface UserSearchCursor {
  matchScore: number;
  createdAt: Date;
  handle: string;
  userId: string;
}

export interface UserSearchConnectionRecord {
  user: UserProfileRecord;
  matchScore: number;
}

export interface AdminUserCursor {
  createdAt: Date;
  userId: string;
}

export interface AdminUserConnectionPage {
  edges: Array<{
    node: AdminUserRecord;
    cursor: string;
  }>;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export interface UserRepositoryPort {
  findById(id: string): Promise<UserProfileRecord | null>;
  findByIds(ids: string[]): Promise<UserProfileRecord[]>;
  findByHandle(handle: string): Promise<UserProfileRecord | null>;
  findAdminById(id: string): Promise<AdminUserRecord | null>;
  searchUsers(input: {
    viewerId?: string;
    query: string;
    limit: number;
  }): Promise<UserProfileRecord[]>;
  searchUsersPage(input: {
    viewerId?: string;
    query: string;
    cursor?: UserSearchCursor;
    take: number;
  }): Promise<UserSearchConnectionRecord[]>;
  findOrCreateWithFallback(input: BootstrapUserDraft): Promise<UserProfileRecord>;
  upsertProfile(userId: string, patch: UpdateProfilePatch): Promise<UserProfileRecord>;
  listDiscoverableUsers(input: { viewerId: string; limit: number }): Promise<UserProfileRecord[]>;
  updateAdminStatus(input: {
    userId: string;
    status: AdminUserStatus;
  }): Promise<AdminUserRecord | null>;
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
  listRecentUsers(limit: number): Promise<AdminUserRecord[]>;
  listAdminUsers(input: {
    query?: string;
    status?: AdminUserStatus;
    cursor?: AdminUserCursor;
    take: number;
  }): Promise<AdminUserRecord[]>;
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
