import { defineConfig } from 'vitest/config';

const coverageExclude = [
  'dist/**',
  'generated/**',
  'prisma/**',
  'test/**',
  'src/**/*.d.ts',
  'src/adapters/outbound/**',
  'src/bootstrap/**',
  'src/application/**/context.ts',
  'src/context.ts',
  'src/contracts/**',
  'src/index.ts',
  'src/prisma.ts',
  'src/resolvers.ts',
  'src/server.ts',
  'src/*Worker.ts',
  'src/migrate.ts',
  'src/user.ts',
  'vitest.config.ts',
  'vitest.integration.config.ts'
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: coverageExclude,
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70
      }
    }
  }
});
