import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildBootstrapUserDraft,
  buildProfileUpsertCreate,
  deriveHandle
} from '../src/domain/profile/user-profile.js';
import { assertCanFollow, assertCanUnfollow } from '../src/domain/profile/follow-relationship.js';
import {
  CannotFollowSelfError,
  CannotUnfollowSelfError
} from '../src/domain/profile/errors.js';
import {
  profileUpdatedEvent,
  userBootstrappedEvent,
  userFollowedEvent,
  userUnfollowedEvent
} from '../src/domain/profile/events.js';

test('deriveHandle normalizes and truncates input', () => {
  const handle = deriveHandle('Hello There!__THIS_IS_LONGER_THAN_32_CHARS');
  assert.equal(handle, 'hellothere__this_is_longer_than_');
});

test('assertCanFollow rejects self-follow', () => {
  assert.throws(
    () => assertCanFollow('u1', 'u1'),
    (error) => error instanceof CannotFollowSelfError
  );
});

test('assertCanUnfollow rejects self-unfollow', () => {
  assert.throws(
    () => assertCanUnfollow('u1', 'u1'),
    (error) => error instanceof CannotUnfollowSelfError
  );
});

test('profile domain builders and events preserve expected shapes', () => {
  const fallbackHandle = deriveHandle('!!');
  assert.match(fallbackHandle, /^user_[a-f0-9]{8}$/);

  const bootstrapDraft = buildBootstrapUserDraft({
    id: 'u1',
    preferredHandle: 'Display Name',
    displayName: 'A'.repeat(100),
    bio: 'bio',
    avatarKey: 'avatar.png'
  });
  assert.equal(bootstrapDraft.handle, 'displayname');
  assert.equal(bootstrapDraft.displayName.length, 80);
  assert.equal(bootstrapDraft.bio, 'bio');
  assert.equal(bootstrapDraft.avatarKey, 'avatar.png');

  const createInput = buildProfileUpsertCreate('u2', { bio: 'next bio' });
  assert.equal(createInput.id, 'u2');
  assert.equal(createInput.displayName, 'New User');
  assert.equal(createInput.avatarKey, null);

  const bootstrapped = userBootstrappedEvent('u1', 'user_1');
  assert.equal(bootstrapped.type, 'UserBootstrapped');
  assert.equal(bootstrapped.payload.userId, 'u1');

  const updated = profileUpdatedEvent('u1', 'user_1');
  assert.equal(updated.type, 'ProfileUpdated');
  assert.equal(updated.payload.handle, 'user_1');

  const followed = userFollowedEvent('u1', 'u2');
  assert.equal(followed.type, 'UserFollowed');
  assert.equal(followed.payload.followingId, 'u2');

  const unfollowed = userUnfollowedEvent('u1', 'u2');
  assert.equal(unfollowed.type, 'UserUnfollowed');
  assert.equal(unfollowed.payload.followerId, 'u1');
});
