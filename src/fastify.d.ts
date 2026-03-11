import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    roles?: string[];
    identityHints?: {
      preferredUsername?: string;
      email?: string;
      name?: string;
      givenName?: string;
      familyName?: string;
    };
  }
}
