import {
  CannotFollowSelfError,
  CannotUnfollowSelfError
} from './errors.js';

export function assertCanFollow(
  followerId: string,
  followingId: string
): void {
  if (followerId === followingId) {
    throw new CannotFollowSelfError();
  }
}

export function assertCanUnfollow(
  followerId: string,
  followingId: string
): void {
  if (followerId === followingId) {
    throw new CannotUnfollowSelfError();
  }
}
