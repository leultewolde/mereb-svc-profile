import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHandle } from '../src/domain/profile/user-profile.js';
import { assertCanFollow, assertCanUnfollow } from '../src/domain/profile/follow-relationship.js';
import {
  CannotFollowSelfError,
  CannotUnfollowSelfError
} from '../src/domain/profile/errors.js';

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
