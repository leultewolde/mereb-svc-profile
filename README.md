# svc-profile

`svc-profile` is the user profile/follow graph service. It exposes a federated GraphQL API and an internal Keycloak bootstrap webhook for provisioning user records.

## API surface

- GraphQL endpoint: `POST /graphql`
- Internal webhook: `POST /internal/users/bootstrap`
- Health check: `GET /healthz`

Core GraphQL operations:

- queries: `me`, `userByHandle`, `adminUserMetrics`, `adminRecentUsers`
- mutations: `updateProfile`, `followUser`, `unfollowUser`

`updateProfile` supports both legacy `avatarKey` and new `avatarAssetId`:

- if `avatarAssetId` is set, it takes precedence over `avatarKey`
- if `avatarAssetId` is `null`, avatar is removed
- if `avatarAssetId` is omitted, legacy `avatarKey` behavior remains

## Keycloak bootstrap webhook

`POST /internal/users/bootstrap` accepts shared-secret or basic-auth protected requests and upserts user bootstrap data.

Accepted auth modes:

- `x-keycloak-webhook-secret` (or `x-internal-token`) matching `KEYCLOAK_WEBHOOK_SECRET`
- `Authorization: Basic ...` matching `KEYCLOAK_WEBHOOK_BASIC_USER/PASS`

Optional allowlist:

- `KEYCLOAK_WEBHOOK_CLIENT_IDS` (comma-separated)

## Environment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | - | Postgres connection string. |
| `OIDC_ISSUER` | yes | - | JWT issuer for GraphQL auth context. |
| `OIDC_AUDIENCE` | no | - | JWT audience/client ID. |
| `MEDIA_SERVICE_URL` | no | `http://localhost:4003` | Used to resolve `avatarAssetId` via `/assets/:id`. |
| `MEDIA_CDN_ORIGIN` | no | `https://cdn.example.com` | Base URL for resolved avatar URLs. |
| `KEYCLOAK_WEBHOOK_SECRET` | conditional | - | Shared secret auth for bootstrap route. |
| `KEYCLOAK_WEBHOOK_BASIC_USER` | conditional | - | Basic auth username for bootstrap route. |
| `KEYCLOAK_WEBHOOK_BASIC_PASS` | conditional | - | Basic auth password for bootstrap route. |
| `KEYCLOAK_WEBHOOK_CLIENT_IDS` | no | - | Optional comma-separated client allowlist. |
| `PORT` | no | `4001` | HTTP listen port. |
| `HOST` | no | `0.0.0.0` | HTTP listen host. |

## Local development

```bash
pnpm --filter @services/svc-profile prisma:migrate
pnpm --filter @services/svc-profile dev
pnpm --filter @services/svc-profile dev:outbox
pnpm --filter @services/svc-profile build
pnpm --filter @services/svc-profile start
```

## Tests

```bash
pnpm --filter @services/svc-profile test
pnpm --filter @services/svc-profile test:integration
pnpm --filter @services/svc-profile test:ci
```
