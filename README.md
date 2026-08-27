# Email Fetch

A local, single-operator application for finding personal GitHub users, collecting public contact details from approved sources, reviewing email confidence, and managing the resulting records. The React interface is backed by a NestJS API, a BullMQ worker, PostgreSQL, and Redis.

The MVP has no application login, bulk export, or automatic retention expiry. It only uses the GitHub API, public email on a GitHub profile, and up to five pages on the website explicitly linked from that profile. Guessed addresses are visibly marked as unsure.

## Run locally

Requirements: Docker Desktop, Docker Compose, and optionally a GitHub personal access token for higher API limits.

1. Copy `.env.example` to `.env` and set `GITHUB_TOKEN` if available.
2. Run `docker compose up --build`.
3. Open <http://127.0.0.1:8080>. The API health endpoint is <http://127.0.0.1:3000/api/health>.

PostgreSQL and Redis listen only on loopback. Application data persists in named Docker volumes. To stop the application without deleting data, run `docker compose down`.

## Develop and verify

Run infrastructure with `docker compose up -d postgres redis`, install dependencies with `npm install`, then use `npm run dev`. The workspace requires Node.js 22 or later.

- `npm run typecheck` checks the API and web app.
- `npm test` runs shared-domain and API unit tests.
- `npm run build` creates production builds for all workspaces.

The database schema is initialized from `infra/postgres/init.sql` when the PostgreSQL volume is first created.

## Specifications

The implementation follows these documents:

- [Collection product specification](./github_spec.md) — filters, asynchronous collection, progress, persistence, and record-management requirements. GitHub is the first source, implemented through a source adapter.
- [Email-sending specification](./EMAIL_SENDING_SPEC.md) — recipient selection, Gmail settings, background sending, progress, sent-status tracking, and provider extensibility.
- [Overall architecture specification](./ARCHITECTURE.md) — shared domain model, adapter contracts, queues, workers, scaling, security boundaries, processing flows, and integration expansion.

GitHub and Gmail are the initial integrations, not hard-coded platform boundaries. Future websites and email providers must be added through the adapter contracts described in the architecture specification.
