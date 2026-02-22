export interface DomainEvent<TType extends string, TPayload> {
  type: TType;
  occurredAt: Date;
  payload: TPayload;
}

export type UserBootstrappedDomainEvent = DomainEvent<
  'UserBootstrapped',
  {
    userId: string;
    handle: string;
  }
>;

export type ProfileUpdatedDomainEvent = DomainEvent<
  'ProfileUpdated',
  {
    userId: string;
    handle: string;
  }
>;

export type UserFollowedDomainEvent = DomainEvent<
  'UserFollowed',
  {
    followerId: string;
    followingId: string;
  }
>;

export type UserUnfollowedDomainEvent = DomainEvent<
  'UserUnfollowed',
  {
    followerId: string;
    followingId: string;
  }
>;

export type ProfileDomainEvent =
  | UserBootstrappedDomainEvent
  | ProfileUpdatedDomainEvent
  | UserFollowedDomainEvent
  | UserUnfollowedDomainEvent;

export function userBootstrappedEvent(
  userId: string,
  handle: string
): UserBootstrappedDomainEvent {
  return {
    type: 'UserBootstrapped',
    occurredAt: new Date(),
    payload: { userId, handle }
  };
}

export function profileUpdatedEvent(
  userId: string,
  handle: string
): ProfileUpdatedDomainEvent {
  return {
    type: 'ProfileUpdated',
    occurredAt: new Date(),
    payload: { userId, handle }
  };
}

export function userFollowedEvent(
  followerId: string,
  followingId: string
): UserFollowedDomainEvent {
  return {
    type: 'UserFollowed',
    occurredAt: new Date(),
    payload: { followerId, followingId }
  };
}

export function userUnfollowedEvent(
  followerId: string,
  followingId: string
): UserUnfollowedDomainEvent {
  return {
    type: 'UserUnfollowed',
    occurredAt: new Date(),
    payload: { followerId, followingId }
  };
}
