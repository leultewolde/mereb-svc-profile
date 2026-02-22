export interface AuthenticatedPrincipal {
  userId: string;
}

export interface ExecutionContext {
  principal?: AuthenticatedPrincipal;
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
