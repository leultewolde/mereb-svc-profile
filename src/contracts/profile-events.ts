export const PROFILE_EVENT_TOPICS = {
  userBootstrapped: 'profile.user.bootstrapped.v1',
  userUpdated: 'profile.user.updated.v1',
  userFollowed: 'profile.user.followed.v1',
  userUnfollowed: 'profile.user.unfollowed.v1',
  userDeactivated: 'profile.user.deactivated.v1',
  userReactivated: 'profile.user.reactivated.v1'
} as const;

export type ProfileEventTopic =
  (typeof PROFILE_EVENT_TOPICS)[keyof typeof PROFILE_EVENT_TOPICS];

export interface ProfileUserBootstrappedEventData {
  user_id: string;
  handle: string;
}

export interface ProfileUserUpdatedEventData {
  user_id: string;
  handle: string;
}

export interface ProfileUserFollowedEventData {
  follower_id: string;
  following_id: string;
}

export interface ProfileUserUnfollowedEventData {
  follower_id: string;
  following_id: string;
}

export interface ProfileUserDeactivatedEventData {
  user_id: string;
}

export interface ProfileUserReactivatedEventData {
  user_id: string;
}

export type ProfileIntegrationEventData =
  | ProfileUserBootstrappedEventData
  | ProfileUserUpdatedEventData
  | ProfileUserFollowedEventData
  | ProfileUserUnfollowedEventData
  | ProfileUserDeactivatedEventData
  | ProfileUserReactivatedEventData;

export interface ProfileIntegrationEventRequest<TData = ProfileIntegrationEventData> {
  topic: ProfileEventTopic;
  eventType: ProfileEventTopic;
  key: string;
  data: TData;
  correlationId?: string;
  causationId?: string;
  tenantId?: string;
}
