# Email Fetch

A local, single-operator application for saving GitHub user filters, running them as background jobs, gathering public contact details from approved sources, reviewing email confidence, and managing the resulting records. The React interface is backed by a NestJS API, a BullMQ worker, PostgreSQL, and Redis.

The MVP has no application login, bulk export, or automatic retention expiry. Collection uses the GitHub API, public email on a GitHub profile, and up to five pages on the website explicitly linked from that profile. Users can also be imported from external JSON. Guessed and newly imported addresses are visibly marked as unsure.

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

Failed collection jobs have a **Continue** button on their job details page (`POST /api/jobs/:id/continue`). It requeues the same job, keeps its saved results and history, and resumes after the last completed profile. Discovery replays search pages to locate the checkpoint; profiles before it are not inspected again, including profiles skipped by filters. The interrupted profile is retried. New checkpoints use the GitHub account ID so a username change does not prevent continuation; older jobs use their saved username. If the checkpoint is no longer in the search results, the job reports that explicitly and the saved filter can be run as a new job. Previous errors stay in the counters and event history, so a successful continuation can finish as **completed with errors**.

## Import users from JSON

Open **Users → Import JSON**, upload a `.json` file or paste JSON, then click **Import users**. The API also accepts the same JSON at `POST /api/users/import` with `Content-Type: application/json`.

Use one object or an array of up to 1,000 objects (maximum 1 MB):

```json
[
  {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "country": "Poland",
    "extra_info": "Frontend developer",
    "fetch_source": "github_hire_me",
    "fetch_page_link": "https://github.com/janedoe"
  }
]
```

`name`, `email`, and `country` are required strings; name and country may be empty. Email must be valid. The other fields are optional: `extra_info` and `fetch_page_link` default to empty strings, and `fetch_source` defaults to `github_hire_me`. Links must use HTTP or HTTPS. JSON uses quoted keys and colons, not equals signs.

The entire batch is validated before saving and saved in one transaction. The result reports `total`, `created`, `updated`, and `skipped` counts. Emails already in the database are skipped, including GitHub contacts, manual contacts, earlier imports, and duplicates within the same file, regardless of `fetch_source`. Email addresses are trimmed and lowercased for matching. Duplicate rows do not create users or change existing user details, email metadata, or sending history. The database's unique email constraint also prevents concurrent inserts from creating duplicate imported users. `updated` only applies when restoring a missing email link on an existing imported account.

Country is stored as the account location for existing filters. Extra info and the source link appear on the Users page. Imported email evidence is labeled `imported` with `unsure` confidence and is not marked publicly verified. Existing email confidence, status, and sending history are preserved. Suppressed people, email addresses, domains, and imported accounts, as well as invalid or deleted email records, are skipped.

Restart the API after updating; its startup migration adds the imported discovery type to existing databases without recreating the volume.

On **Emails**, the Country filter lists the distinct countries found across stored users, and the Country column shows the countries linked to each email. Imported country fields take precedence; GitHub locations with an explicit country (for example, `Warsaw, Poland`) are recognized, including common aliases such as `USA`. **None** selects emails without a recognized country, including blank, city-only, and ambiguous locations. Options come from the full user list rather than the current email page or a fixed dropdown list.

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
