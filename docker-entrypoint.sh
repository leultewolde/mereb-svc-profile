#!/bin/sh
set -euo pipefail

if [ "${SKIP_PRISMA_MIGRATE:-0}" != "1" ]; then
  echo "[entrypoint] Running prisma migrate deploy..."
  pnpm prisma migrate deploy
else
  echo "[entrypoint] Skipping prisma migrate deploy (SKIP_PRISMA_MIGRATE=1)"
fi

exec node dist/index.js
