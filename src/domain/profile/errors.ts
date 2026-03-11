export class ProfileDomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProfileDomainError';
  }
}

export class AuthenticationRequiredError extends ProfileDomainError {
  constructor() {
    super('UNAUTHENTICATED', 'Authentication required');
  }
}

export class AuthorizationRequiredError extends ProfileDomainError {
  constructor() {
    super('FORBIDDEN', 'Administrator access required');
  }
}

export class ProfileUserNotFoundError extends ProfileDomainError {
  constructor() {
    super('USER_NOT_FOUND', 'User not found');
  }
}

export class CannotFollowSelfError extends ProfileDomainError {
  constructor() {
    super('CANNOT_FOLLOW_SELF', 'A user cannot follow themselves');
  }
}

export class CannotUnfollowSelfError extends ProfileDomainError {
  constructor() {
    super('CANNOT_UNFOLLOW_SELF', 'A user cannot unfollow themselves');
  }
}

export class InvalidMediaAssetError extends ProfileDomainError {
  constructor(message = 'Invalid media asset') {
    super('INVALID_MEDIA_ASSET', message);
  }
}
