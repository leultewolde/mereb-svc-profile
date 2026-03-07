export interface AuthenticatedPrincipal {
  userId: string;
}

export interface IdentityHints {
  preferredUsername?: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
}

export interface ExecutionContext {
  principal?: AuthenticatedPrincipal;
  identity?: IdentityHints;
  correlationId?: string;
  causationId?: string;
  tenantId?: string;
}

export function requireUserId(ctx: ExecutionContext): string {
  const userId = ctx.principal?.userId;
  if (!userId) {
    throw new Error('UNAUTHENTICATED');
  }

  return userId;
}
