# PULSE//FIELD commerce platform

This repository is a portfolio-grade, modular e-commerce platform built in demonstrable phases. It is intentionally local-first: the default profile uses only open tooling on the developer machine and has no deployment, subscription, credit-card, or SaaS credential requirement.

## Current milestone

Phases 1–5 are complete. The user closed Phase 5 on 2026-10-01 with visual review deferred; this does not imply visual approval. Concurrency, live browser recovery and multiple API-process acceptance pass. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for dated evidence and the recorded sign-off.

Phase 6 Slices 6.1–6.4b provide regional storefront shopping and authoritative checkout
for US/USD, Morocco/MAD, EU/EUR and UK/GBP. Fixed price books, simulated tax,
versioned shipping and exact warehouse routes determine original charges;
immutable order snapshots retain separate USD reporting evidence. Catalog accepts
`market=US|MA|EU|UK`; cart selection requires repricing and explicit confirmation.
Checkout validates the destination against that confirmed market. Four-market
acceptance uses the local payment stub; Stripe test-mode remains US/USD only.
Historical US orders and committed replay remain compatible. The storefront carries
browsing selection through market query links/search and formats the API currency.
Product/cart changes and checkout destination mismatches require full repricing
review and explicit confirmation. Uncertain checkout attempts lock their inputs and
retry the exact body, revision and key in the open page; keep it open until the
outcome is known. Public pages include regional canonical/OpenGraph metadata and
English country alternates; product HTML and Product/Offer JSON-LD share the API
snapshot. The sitemap includes public market pages only. Local pages remain
noindex/nofollow and robots disallow-all; visual approval is separate.

Phase 6.5 functional acceptance passed on 2026-10-05: quality (104 suites / 778
tests and all builds), full PostgreSQL integration (24 suites / 236 tests), 23
browser checks, synthetic forward migration preserving legacy USD orders/replay,
and four regional HTTP checkout/replay journeys with captured local confirmations.
Manual visual sign-off and formal phase closure remain pending.

Run `pnpm quality`, then `node scripts/run-phase6-browser-acceptance.mjs` for
regional storefront and SEO acceptance. The latter requires local PostgreSQL/Redis, current
builds and free ports 3000/4000; it owns both application processes, a fresh guarded
`phase64_browser_<random>_test` database and an empty Redis database without flushing.
It tests JavaScript-disabled product pages and an actual owned API outage, retains
test data, stops its processes and never migrates/seeds development. See the
[environment reference](docs/environment.md#regional-seo-server-connection) for
the server catalog connection and public URL origin.

For complete Phase 6 functional acceptance, run these commands from the repository
root with local PostgreSQL, ephemeral Redis and Mailpit available:

```powershell
pnpm quality
node scripts/phase6/integration.mjs
node scripts/phase6/forward-migration.mjs
node scripts/phase6/http-mailpit.mjs
node scripts/run-phase6-browser-acceptance.mjs
```

The integration and forward-migration commands each create a fresh guarded local
`_test` database. HTTP/Mailpit uses the successful forward rehearsal's retained
target from `.local/acceptance/phase65-forward-result.json`, with an empty local
Redis database selected without flushing. It verifies four stub checkout/replay
journeys and captured confirmations through direct relay/processor invocation;
it does not test BullMQ transport recovery. The predecessor rehearsal is synthetic,
using committed legacy checkout code and temporary client compatibility columns;
it is not a production backup restore. All tools retain test data and never
migrate/reset/seed development. Manual visual sign-off remains separate.

The protected Phase 3 operations dashboard is available at `/operations` after staff password and local TOTP MFA authentication. It uses masked, read-only projections; only fulfillers can advance the existing fulfillment path. Checkout defaults to the non-networked stub and the selected market’s configured warehouse route; no Stripe or hosted payment service is required. Optional Stripe mode is test-only: it mounts the embedded Payment Element after server-owned checkout preparation, and only the verified asynchronous webhook/reconciliation path may confirm payment. Checkout collects an order-contact email, links guests to a digest-protected expiring timeline, and delivers confirmation only through the encrypted local Mailpit workflow after authoritative order confirmation.

The storefront uses a light, responsive presentation across the homepage,
catalog, product detail, cart, active checkout form, and guest order timeline.
Navigation, search, filters, variant selection, cart revisions, and server-owned
checkout behavior remain connected to the existing `/api/v1` contracts.

## Quick start

Prerequisites: Node `24.19.0`, pnpm `11.19.0`, and Docker Compose. Docker is required only for the persistent and supporting local services; no cloud account is needed.

The quality validators use the existing TypeScript compiler through a local Node
runner, avoiding the Windows `tsx` account-lookup startup failure. Run
`pnpm quality` as usual; see [the testing guide](docs/testing.md) for details.

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
- Staff operations projections: `GET http://localhost:4000/api/v1/staff/operations/{catalog|inventory|reservations|orders|payments|reconciliation|fulfillment|audit}`
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
- Live, malformed, or incomplete Stripe credential or webhook-secret configuration
- Any enabled billable provider adapter

The default payment provider is a non-networked stub. Optional Stripe mode requires an ignored test-key pair and `whsec_` endpoint signing secret; automated acceptance still makes no Stripe network calls. No Stripe account, Stripe CLI, email service, hosted database, managed Redis, deployment, or real recipient is needed for the default profile.

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
pnpm test:phase5
pnpm test:e2e
pnpm build
pnpm quality
```

`pnpm quality` is the dependency-free local gate and keeps database integration tests separate. With local PostgreSQL running, `pnpm test:integration` derives and guards a dedicated `pulsefield_test` database, applies committed migrations, and runs the real persistence tests. See [docs/testing.md](docs/testing.md) for the validation matrix and [docs/local-operations.md](docs/local-operations.md) for database safeguards.

`pnpm test:phase5` runs the Phase 5 concurrency matrix against a fresh local
`slice56_<random>_test` database. `pnpm test:phase5 --full` runs all guarded
integration suites on a fresh target. Both use the existing source runner without
TSX, retain their test database for inspection, and never migrate/reset/seed the
development database. The focused matrix is database-service evidence; browser
recovery and multiple API processes require separate rehearsals.

`pnpm test:phase5:browser` runs real split checkout, inventory/transfer operations,
independent fulfillment, Socket.IO disconnect/reconnect and role-denial checks.
Build first, start the web application on localhost:3000, and leave API port
4000 free. Local PostgreSQL and ephemeral Redis plus the ignored demo staff
passwords are required. The runner migrates/seeds only a new owned `_test`
database, starts and stops its own stub-payment API, and retains test data.
See [the browser procedure](docs/testing.md#phase-56-live-browser-acceptance).

`pnpm test:phase5:processes` runs 50 simultaneous HTTP checkouts through two
owned local API processes on ports 4100/4101, sharing one fresh seeded `_test`
database and isolated local cache. It needs the same build and local environment
as browser acceptance, but no running web application. It retains test data and
stops only its owned processes. Recognized checkout transaction contention
returns a safe `503 CHECKOUT_TEMPORARILY_UNAVAILABLE`; the rehearsal retries the
original request/key through the other process and verifies conserved inventory
and unchanged replay effects. Unknown errors remain failures.

## Documentation

- [Architecture and module boundaries](docs/architecture.md)
- [Environment reference](docs/environment.md)
- [Local topology and database operations](docs/local-operations.md)
- [Security baseline](docs/security.md)
- [Testing guide](docs/testing.md)
- [Architecture decisions](docs/adr/README.md)

## Inventory operations

The protected administrator operations area supports bounded stock adjustments,
low-stock thresholds, warehouse transfer dispatch/receipt/cancellation, and
page-scoped read-only reconciliation. It remains local-only and uses the
existing session, MFA, CSRF, idempotency, audit, and PostgreSQL safeguards.
For a local administrator rehearsal, sign in with a recent MFA-backed administrator
session, open **Operations → Inventory**, adjust on-hand or damaged stock with a
reason, and set a threshold. Open **Transfers** to create a multiline requested
transfer, inspect its quantities, dispatch it, then enter received, damaged, and
lost values for every line; an all-lost receipt is valid. Use **Low stock** and
**Inventory reconciliation** to inspect bounded, page-scoped expected/actual
evidence. Repeating a command with the same idempotency key replays its original
response; uncertain network outcomes retain the exact retry. Browser tests use a
mocked API, while PostgreSQL integration tests provide live persistence evidence;
neither is a visual-approval claim.
