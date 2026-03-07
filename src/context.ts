export interface IdentityHints {
  preferredUsername?: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
}

export interface GraphQLContext {
  userId?: string;
  identity?: IdentityHints;
}
