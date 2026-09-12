# PULSE//FIELD commerce platform

This repository is a portfolio-grade, modular e-commerce platform built in demonstrable phases. It is intentionally local-first: the default profile uses only open tooling on the developer machine and has no deployment, subscription, credit-card, or SaaS credential requirement.

## Current milestone

Phase 1, **Architecture and delivery foundation**, Phase 2, **Identity and reliable messaging foundation**, and Phase 3, **Reference vertical slice**, are complete as of 2026-09-12. Phase 3 includes the deterministic US/USD catalog and inventory foundation, public storefront discovery, a persistent anonymous cart, policy-versioned checkout with a local payment stub, reservation/order snapshots, bounded reservation expiry, linear staff fulfillment transitions, local SVG product media, accessible storefront pages, protected operations projections, staff MFA, deterministic demo reset, and the complete browser acceptance journey. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exact final evidence and the canonical-wrapper `ENOMEM` caveat.

The protected Phase 3 operations dashboard is available at `/operations` after staff password and local TOTP MFA authentication. It uses masked, read-only projections; only fulfillers can advance the existing fulfillment path. The checkout and fulfillment path use only the non-networked stub and seeded `US-EAST-01` warehouse; no Stripe or hosted payment service is required.

## Quick start

Prerequisites: Node `24.19.0`, pnpm `11.19.0`, and Docker Compose. Docker is required only for the persistent and supporting local services; no cloud account is needed.

```powershell
Copy-Item .env.example .env
pnpm local:secrets
pnpm install --frozen-lockfile
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then open:

- Storefront foundation: `http://localhost:3000`
- Public catalog: `http://localhost:3000/catalog`
- Staff operations: `http://localhost:3000/operations`
- API health: `http://localhost:4000/api/v1/health`
- Public catalog list: `GET http://localhost:4000/api/v1/catalog/products`
- Public product detail: `GET http://localhost:4000/api/v1/catalog/products/:slug`
- Anonymous cart: `GET http://localhost:4000/api/v1/cart`
- Set cart line: `PUT http://localhost:4000/api/v1/cart/items/:variantId`
- Remove cart line: `DELETE http://localhost:4000/api/v1/cart/items/:variantId`
- Checkout preview: `POST http://localhost:4000/api/v1/checkouts/preview`
- Create checkout: `POST http://localhost:4000/api/v1/checkouts`
- Staff fulfillment transition: `POST http://localhost:4000/api/v1/staff/fulfillment-groups/:id/transitions`
- Staff operations projections: `GET http://localhost:4000/api/v1/staff/operations/{catalog|inventory|reservations|orders|payments|fulfillment|audit}`
- OpenAPI UI: `http://localhost:4000/api/docs`
- Customer registration: `POST http://localhost:4000/api/v1/auth/registrations`
- Email verification: `POST http://localhost:4000/api/v1/auth/email-verifications`
- Login: `POST http://localhost:4000/api/v1/auth/sessions`
- Current session: `GET http://localhost:4000/api/v1/auth/sessions/current`
- Logout: `DELETE http://localhost:4000/api/v1/auth/sessions/current`
- Mailpit inbox: `http://localhost:8025`
- Jaeger trace UI: `http://localhost:16686`

For a full in-container rehearsal, run `docker compose --profile apps up --build`. The default `docker compose up` starts only supporting services so web, API, and worker can run quickly on the host.

With the worker and local services running, `pnpm smoke:messaging` publishes an encrypted disposable job and verifies that Mailpit captured it. `pnpm diagnostics:messaging` reports only aggregate outbox, delivery-ledger, and queue counts. Neither command prints delivery credentials or recipients. Registration, verification, and session requests are documented interactively in OpenAPI. Public credential routes and server-side sessions require the ephemeral Redis service and fail closed when their protection state is unavailable.

## Local-only safety contract

`LOCAL_DEVELOPMENT_PROFILE=zero-cost-local` is mandatory. Startup and `pnpm validate:env` reject:

- Remote PostgreSQL, Redis, SMTP, telemetry, and web origins
- Non-Mailpit SMTP hosts or external SMTP permission
- Missing or malformed local queue-message encryption keys
- Live Stripe key formats
- Stripe activation in the default local profile
- Any enabled billable provider adapter

The default payment provider is a non-networked stub. No Stripe account, Stripe CLI, email service, hosted database, managed Redis, deployment, or real recipient is needed for this milestone.

When rotating the ignored local message-encryption key, use `pnpm local:rotate-message-key`, `pnpm local:reencrypt-totp-secrets`, and `pnpm local:complete-message-key-rotation` in the documented order. Do not replace the key by hand: it also protects staff TOTP data and queued notification payloads.

## Quality commands

```powershell
pnpm validate:env
pnpm boundaries
pnpm compose:config
pnpm secrets:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm quality
```

`pnpm quality` is the dependency-free local gate and keeps database integration tests separate. With local PostgreSQL running, `pnpm test:integration` derives and guards a dedicated `pulsefield_test` database, applies committed migrations, and runs the real persistence tests. See [docs/testing.md](docs/testing.md) for the validation matrix and [docs/local-operations.md](docs/local-operations.md) for database safeguards.

## Documentation

- [Architecture and module boundaries](docs/architecture.md)
- [Environment reference](docs/environment.md)
- [Local topology and database operations](docs/local-operations.md)
- [Security baseline](docs/security.md)
- [Testing guide](docs/testing.md)
- [Architecture decisions](docs/adr/README.md)
