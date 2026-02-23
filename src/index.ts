import { buildServer } from './server.js';
import { getNumberEnv, initDefaultTelemetry, loadEnv } from '@mereb/shared-packages';
import { startProfileOutboxRelay } from './bootstrap/outbox-relay.js';

loadEnv();
initDefaultTelemetry('svc-profile');

const PORT = getNumberEnv('PORT', 4001);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
    const app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
    startProfileOutboxRelay();
    console.log(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
}
