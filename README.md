# Email Fetch

A local, single-operator application for saving GitHub user filters, running them as background jobs, gathering public contact details from approved sources, reviewing email confidence, and managing the resulting records. The React interface is backed by a NestJS API, a BullMQ worker, PostgreSQL, and Redis.

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

## Gmail sending

The local application can send immediate, plain-text campaigns through one connected Gmail account.

1. Enable the Gmail API and create a Google OAuth **Web application** client.
2. Configure `http://127.0.0.1:8080` as an authorized JavaScript origin.
3. Configure `http://127.0.0.1:3000/api/email-providers/gmail/oauth/callback` as an authorized redirect URI.
4. Add `gmail.send` to the OAuth consent screen and add the sender account as a test user while the app is in Testing mode.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, and `GMAIL_TOKEN_ENCRYPTION_KEY` in `.env`. Optionally seed approved test addresses with comma-separated `GMAIL_TEST_RECIPIENTS`; the older singular `GMAIL_TEST_RECIPIENT` setting remains supported. The `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` aliases are also supported.
6. Open **Settings** and connect Gmail, then create a plain-text template under **Templates**.
7. Add or remove approved test recipients under **Settings**, then select individual addresses or all active addresses on the current **Emails** page, choose a template, review the immutable preview, and confirm automatic sending.

Refresh tokens are encrypted with AES-256-GCM before being stored. The encryption key and OAuth client secret must remain in the ignored `.env` file. The default safety policy allows one active campaign, blocks repeat contact, limits sends to 100 per rolling day and 25 per hour, and spaces Gmail submissions by at least five seconds. Every message includes a reply-based opt-out instruction; opt-outs are applied manually with the suppress action on the Emails page.

## Specifications

The implementation follows these documents:

- [Collection product specification](./github_spec.md) — filters, asynchronous collection, progress, persistence, and record-management requirements. GitHub is the first source, implemented through a source adapter.
- [Email-sending specification](./EMAIL_SENDING_SPEC.md) — recipient selection, Gmail settings, background sending, progress, sent-status tracking, and provider extensibility.
- [Overall architecture specification](./ARCHITECTURE.md) — shared domain model, adapter contracts, queues, workers, scaling, security boundaries, processing flows, and integration expansion.

GitHub and Gmail are the initial integrations, not hard-coded platform boundaries. Future websites and email providers must be added through the adapter contracts described in the architecture specification.
