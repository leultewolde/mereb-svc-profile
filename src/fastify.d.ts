import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    identityHints?: {
      preferredUsername?: string;
      email?: string;
      name?: string;
      givenName?: string;
      familyName?: string;
    };
  }
}
