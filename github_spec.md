# Multi-Source Public User and Email Collector — Product Specification

## 1. Purpose

Build a web application that finds public user profiles matching selected filters, gathers as much relevant publicly accessible profile and contact information as permitted, discovers or derives candidate email addresses, stores them with provenance and confidence, and provides an interface for monitoring collection jobs and managing collected records.

GitHub is the only collection source in the first release. The product must nevertheless use a source-neutral domain model and pluggable source adapters so additional websites can be added without rewriting job orchestration, persistence, progress reporting, or management pages.

The system must collect only publicly available data through methods permitted by each source's terms, API policies, robots controls, and applicable law. It must not bypass authentication, privacy settings, rate limits, or other access restrictions.

## 2. Goals

- Let an operator define a target audience with filters.
- Run long-lived collection work asynchronously.
- Display live or near-live job status and progress.
- Store normalized user and email records with source evidence.
- Deduplicate users and email addresses across jobs.
- Enrich a user from their public profile, linked personal website, and other permitted public pages while preserving field-level provenance.
- Clearly distinguish directly published email addresses from discovered, inferred, or guessed addresses.
- Let authorized operators search, review, export, suppress, and delete collected data.
- Let operators quickly find users and email addresses that have never been sent an email.
- Save previously executed search/filter definitions so an operator can inspect and run them again.
- Make collection reliable, resumable, rate-limit-aware, and auditable.

## 3. Non-goals

- Circumventing source controls or using credentials without authorization.
- Sending marketing or transactional email; that workflow is specified separately in [EMAIL_SENDING_SPEC.md](./EMAIL_SENDING_SPEC.md).
- Accessing private or hidden personal data, or enriching records with information unrelated to identifying and contacting the selected user.
- Presenting a guessed or uncertain email address as verified or publicly declared.
- Confirming an address by sending unsolicited email or probing a mail server mailbox.
- Guaranteeing that every matching source account has a public email address.

## 3.1 Multi-source design requirements

- GitHub must be implemented as a source adapter, not embedded in shared collection logic.
- Every job targets exactly one source in the MVP. A future parent job may coordinate child jobs across multiple sources.
- Each adapter publishes its supported filter schema and capabilities to the application.
- The UI renders source-specific filters from that schema while retaining a consistent job workflow.
- Shared records use internal IDs; external usernames and IDs are scoped by source.
- Source-specific fields are stored separately from normalized fields.
- A source adapter owns discovery, pagination, profile retrieval, field mapping, rate-limit interpretation, and checkpoint serialization.
- The core platform owns authorization, queues, retries, progress, normalized persistence, suppression, exports, and audits.
- Adding a source must not require schema changes unless it introduces a genuinely new shared concept.
- Cross-source identity merging must be conservative and auditable. Matching names or usernames alone is never sufficient.

## 4. Users and roles

### Administrator

- Manages application users, credentials, retention settings, and suppression rules.
- Can view, export, suppress, and permanently delete collected records.
- Can view audit history.

### Operator

- Creates and manages collection jobs.
- Views job progress, failures, and collected records.
- Can export records if granted permission.

### Viewer

- Has read-only access to jobs and collected records.

## 5. Primary workflow

1. An operator opens the **New Collection** page.
2. The operator selects a source. GitHub is the only enabled choice in the MVP.
3. The application loads the source's supported filters and capabilities.
4. The operator selects filters, optionally starts from search history, and sees a summary of the proposed search.
5. The application validates the filters and displays any expected limitations.
6. The operator starts the collection.
7. The application creates a background job and immediately returns a job ID.
8. Background workers discover matching users through the selected adapter, normalize results, and save them incrementally.
9. The job page updates progress, counters, warnings, rate-limit status, and errors.
10. The operator can pause, resume, or cancel the job.
11. Completed records appear on the **Collected Users** and **Emails** pages, including email origin and confidence.
12. Each successfully executed collection or table search stores its normalized filter definition in the initiating operator's search history.

## 6. Filters

The GitHub adapter in the first release should support:

- Location text, such as country, city, or region.
- Programming language.
- Minimum and maximum follower count.
- Minimum and maximum public repository count.
- Account type: user or organization, with user selected by default.
- Account creation date range.
- Last public activity date range, when available through the permitted source.
- Keywords found in public profile fields, such as bio or company.
- Require public email: yes or no.
- Email discovery policy: direct source only, include linked-site/public-search discovery, or include guessed candidates.
- Minimum email confidence: confirmed, likely, or unsure.
- Exclude previously processed users: yes or no.
- Maximum number of users to inspect.

Filter behavior:

- All active filters are combined with AND unless explicitly presented as a multi-value OR filter.
- The interface must show the exact filter definition saved with each job.
- Inputs must be validated before the job is queued.
- Limits must protect the service from accidentally creating unbounded jobs.
- Results are best-effort because source search indexes and public profile data may be incomplete or change over time.
- The application must reject filters that the selected source does not support.
- Common filters may have source-specific semantics; the saved job must preserve both the normalized filter and the adapter-specific query.
- A search is added to history only after it is submitted successfully; ordinary form edits and keystrokes must not create history entries.
- Re-running a history entry uses the saved filter definition but creates a new execution timestamp and, for collection searches, a new job.

## 7. Collection rules

For each discovered account, the collector may store only relevant fields available through approved public sources. The collector should gather all useful supported fields, including display name, login, bio, company, location, account type, avatar and profile URLs, public website and social links, public activity metadata, follower/repository counts, and contact details. Every collected or derived field must retain its source, collection time, and derivation method.

The collector must:

- Record the source URL or API resource and collection timestamp.
- Distinguish an email published directly on the source profile, one found on a publicly linked website, one inferred from public evidence, one guessed from a documented pattern, and a missing email.
- When the source profile has no direct email, inspect the user's linked personal or company website and its publicly accessible contact/about pages when permitted by site terms and robots controls. A configured, approved public web-search provider may be used to locate relevant pages for that same person or organization.
- If no email is published, optionally generate a bounded set of plausible candidates from public identity and domain evidence. Store the derivation rule and supporting evidence; never label these candidates as confirmed.
- Assign every email a confidence label: `confirmed`, `likely`, or `unsure`. Guessed addresses default to `unsure`; they may become `likely` only through additional non-invasive public evidence. Only an address explicitly displayed by an authoritative public source may be `confirmed` and `is_publicly_declared = true`.
- Treat syntactic and domain checks as validation signals only. They do not prove that a mailbox exists or belongs to the user.
- Exclude guessed or unsure addresses from exports and sending by default; inclusion requires an explicit confidence filter and a policy-controlled override.
- Respect configured request concurrency, source rate limits, retry headers, and backoff rules.
- Stop or delay work when credentials are invalid or a source rate limit is exhausted.
- Skip records on the suppression list.
- Re-check whether a record is suppressed before persistence and export.
- Avoid repeatedly requesting the same account within a configurable freshness window.
- Sanitize untrusted profile text before displaying it.

For the GitHub adapter, linked-website enrichment is a separately observable enrichment stage within a GitHub collection job. If commit-derived email collection is added later, it must be a separate, disabled-by-default capability with an explicit legal and policy review. The stored record must identify that method and must never treat GitHub-provided private relay addresses as personal email addresses.

## 8. Background jobs

### Job states

- `queued`
- `running`
- `paused`
- `rate_limited`
- `completed`
- `completed_with_errors`
- `failed`
- `cancelling`
- `cancelled`

### Required capabilities

- Enqueue work outside the web request lifecycle.
- Break a job into resumable batches.
- Persist cursors/checkpoints so a worker restart does not restart the whole job.
- Make batch processing idempotent.
- Retry transient failures with exponential backoff and jitter.
- Do not retry permanent failures indefinitely.
- Support pause, resume, and cancellation at batch boundaries.
- Prevent two workers from processing the same batch concurrently.
- Save results continuously rather than only at job completion.
- Store structured error samples without exposing secrets.

### Progress data

Each job should expose:

- Current state and current phase.
- Creation, start, update, and completion timestamps.
- Number of candidate users discovered.
- Number of users inspected.
- Number of users with public email addresses.
- Number of confirmed, likely, unsure, and guessed email candidates.
- Number of new and updated users.
- Number of duplicate, suppressed, and skipped records.
- Number of requests, retries, and errors.
- Current rate-limit status and estimated resume time, if known.
- Estimated completion percentage when a reliable total is known; otherwise an indeterminate progress indicator.
- A short, sanitized recent-event log.

The browser should receive updates through Server-Sent Events or WebSockets, with polling as a fallback.

## 9. Data model

### `app_users`

- `id`
- `email`
- `password_hash` or external identity reference
- `role`
- `status`
- `created_at`, `updated_at`, `last_login_at`

### `collection_jobs`

- `id`
- `created_by`
- `name`
- `source_id`
- `source_adapter_version`
- `status`
- `filters_json`
- `adapter_query_json`
- `source_config_json` containing no raw secrets
- Progress counters
- Checkpoint/cursor data
- `started_at`, `completed_at`, `created_at`, `updated_at`
- Failure code and sanitized failure message

### `job_events`

- `id`
- `job_id`
- `level`
- `event_type`
- `message`
- `metadata_json`
- `created_at`

### `sources`

- `id` and stable source key, such as `github`
- Display name
- Adapter version
- Enabled status
- Capability and filter-schema metadata
- Created and updated timestamps

### `people`

- Internal `id`
- Preferred display name
- Lifecycle status
- First seen and last updated timestamps
- `is_suppressed`, `suppressed_at`, and suppression reason

This table represents the platform's normalized person record. A person can have accounts on multiple sources. The MVP may create one person per source account and merge only when an approved deterministic identity rule applies.

### `source_accounts`

- Internal `id`
- `person_id`
- `source_id`
- Stable external account ID within that source
- Username/login, display name, profile URL, and avatar URL
- Bio, company, location
- Account type
- Normalized public content and follower counts where supported
- Account creation date
- Source update timestamp, first seen timestamp, and last checked timestamp
- `is_suppressed`, `suppressed_at`, and suppression reason
- Source-specific attributes JSON for non-normalized fields
- Raw source payload only if justified, minimized, encrypted as appropriate, and assigned a retention period

### `email_addresses`

- `normalized_email` as the table's primary key; there is no second surrogate primary key
- `person_id`
- Original displayed value, if needed
- `is_publicly_declared`
- Discovery type: `source_profile`, `linked_website`, `public_web_search`, `inferred`, or `guessed`
- Confidence: `confirmed`, `likely`, or `unsure`
- Confidence score, derivation rule, and review status where applicable
- First seen, last seen, and last verified timestamps
- Status: `active`, `no_longer_public`, `invalid`, `suppressed`, or `deleted`
- Optional validation status; validation must not send unsolicited messages

`normalized_email` is the canonical global identity for an email-bearing record. Normalization must be deterministic and versioned: trim surrounding whitespace, normalize the domain to lowercase IDNA ASCII, apply the product's documented local-part case policy, and reject syntactically invalid values before persistence. All API, import, collection, and enrichment paths must call the same normalizer.

People without an email still use `people.id`. Any user result that contains an email must reference the canonical `email_addresses.normalized_email` primary key rather than copying an unconstrained address into a separate user table.

### `email_sources`

- `normalized_email` referencing `email_addresses.normalized_email`
- `source_account_id`
- Collection job ID
- Source method and evidence URL/resource
- Evidence excerpt or structured derivation inputs, minimized to what is needed for review
- First seen, last seen, and last verified timestamps

This join preserves provenance when the same email is observed on more than one account or website.

### `search_history`

- `id`
- `app_user_id`
- Context: `new_collection`, `collected_users`, or `emails`
- Source ID when applicable
- Normalized, versioned `filters_json` and allowlisted `sort_json`
- Optional human-readable label
- Stable filter hash for grouping identical searches
- Result count when known
- Optional collection job ID created from the search
- `executed_at`, `last_executed_at`, and execution count
- Expiration/deletion timestamp according to the configured retention policy

History is private to the initiating application user unless explicitly shared by an authorized role. Secrets, credentials, free-form page contents, and raw source responses must never be stored in filter history.

Pagination, page-size changes, and background refreshes do not create separate history entries. Repeated execution of the same logical filters may update the existing filter-hash entry's execution count and timestamps while retaining links to any collection jobs it created.

### `job_results`

- `job_id`
- `source_account_id`
- `person_id`
- Outcome: confirmed email found, likely email found, guessed/unsure email found, no email found, duplicate, suppressed, skipped, or error
- `processed_at`
- Error code, when applicable

### `suppressions`

- `id`
- Type: email, domain, source account ID, or source-scoped username
- Optional `source_id` for source-scoped suppressions
- Normalized value or privacy-preserving hash where practical
- Reason and source
- `created_by`, `created_at`

### `audit_log`

- Actor, action, target type, target ID
- Redacted metadata
- Timestamp and request correlation ID

### Constraints and indexing

- Unique index on `(source_id, external_account_id)`.
- Unique index on `(source_id, normalized_username)` when the source guarantees username uniqueness.
- Primary key on `email_addresses.normalized_email`, enforcing global email uniqueness.
- Unique constraint on `(normalized_email, source_account_id, source_method)` in `email_sources` so the same evidence is not duplicated.
- Every email insert uses an atomic database upsert inside the same transaction as its provenance link. Concurrent discovery of the same normalized address must update/merge the existing row, never create a duplicate.
- If an interactive create endpoint is explicitly create-only, an existing normalized email returns HTTP `409`; collector/import paths are idempotent upserts.
- Conflicting person ownership for an existing email must create an auditable identity-review event instead of silently reassigning or duplicating the email.
- Index job status and creation time for worker claiming.
- Index common management filters such as login, display name, company, location, source, job, email status, email confidence, discovery type, first seen, last checked, `last_sent_at`, and `successful_send_count`.
- Index search history by `(app_user_id, context, last_executed_at)` and by filter hash.
- Use soft suppression for opt-outs, but support irreversible deletion of the underlying personal data.

## 10. Web interface

### Dashboard

- Counts for active jobs, completed jobs, users, active public emails, and recent errors.
- Recent jobs with status and progress.
- Source health and rate-limit warnings.

### New Collection

- Source selector; GitHub is the only enabled source in the MVP.
- Filter form with validation and sensible limits.
- Adapter-provided source filters rendered within the shared form layout.
- Human-readable filter preview.
- Collection limit and optional job name.
- Confirmation before starting a large job.
- A per-user recent-search control that can preview, reapply, rename, or delete a saved filter definition.

### Job Detail

- State, phase, progress indicators, and timestamps.
- All progress counters listed in section 8.
- Saved filter definition.
- Pause, resume, cancel, and retry-failed-batches controls as appropriate to state and role.
- Paginated results and sanitized error/event log.

### Collected Users

- Search by login, name, company, location, or email.
- Filter by source, job, collection date, email status, email confidence, discovery type, suppression status, and email send status.
- Provide a prominent **Never sent** filter, defined as no successful non-test campaign-recipient record for any selected email; for multi-email users, support both **no address sent** and **has an unsent address** semantics.
- Sort and paginate server-side.
- View a person's linked source accounts, stored profiles, source evidence, job history, and change history.
- Suppress or delete a user according to permissions.

### Emails

- Search and filter by normalized email, domain, status, source, and date.
- Filter by confidence, discovery type, review status, send status (`never_sent`, `sent`, `failed_latest_attempt`, or `suppressed`), campaign, and sent-date range.
- Provide a one-click **Never sent** view. Campaign-recipient history is authoritative; `last_sent_at` and `successful_send_count` may be maintained as repairable projections for fast filtering.
- Copy an individual value where authorized.
- Export the current filtered result set.
- Suppress or delete records.
- Mask email values for viewers without the permission to reveal them.

### Application Users

- Administrator-only list of users and roles.
- Invite, deactivate, and change role actions.
- Authentication/session history appropriate for security review.

### Settings

- Source adapter list, enabled state, health, capabilities, and credential status.
- Per-source credentials stored through a secret manager, never displayed after entry.
- Concurrency and request-rate limits.
- Freshness window, retry limits, and retention periods.
- Export permissions and suppression rules.

### Search History

- Show the current user's previously executed collection, user-table, and email-table searches newest first.
- Display the context, human-readable filter summary, execution count, last execution time, and prior result count.
- Allow the user to re-run, rename, or delete a history entry and clear their history subject to audit/retention policy.
- Enforce current authorization and current filter capabilities when re-running old history; saved history never bypasses permissions.

## 11. API outline

The exact protocol is implementation-specific. A REST-style API may include:

- `POST /api/jobs` — validate filters and create a collection job.
- `GET /api/jobs` — list jobs.
- `GET /api/jobs/{id}` — return job configuration and progress.
- `POST /api/jobs/{id}/pause`
- `POST /api/jobs/{id}/resume`
- `POST /api/jobs/{id}/cancel`
- `GET /api/jobs/{id}/events` — stream or paginate updates.
- `GET /api/users` and `GET /api/users/{id}`
- `DELETE /api/users/{id}`
- `POST /api/users/{id}/suppress`
- `GET /api/emails`
- `POST /api/emails` — create an email-bearing record; normalize first and return `409` when its primary key already exists.
- `POST /api/emails/{normalized_email}/suppress`
- `GET /api/search-history` — list the current user's history by context.
- `POST /api/search-history/{id}/run` — re-run an authorized saved search.
- `PATCH /api/search-history/{id}` and `DELETE /api/search-history/{id}` — rename or remove an entry.
- `POST /api/exports` — create an audited asynchronous export.
- Administrator-only endpoints for application users and settings.

All list endpoints must support pagination, bounded page sizes, allowlisted sorting, and structured filters. Mutation endpoints should accept an idempotency key where duplicate submission is possible.

Successful user-initiated executions of `GET /api/users`, `GET /api/emails`, and validated collection searches must record normalized logical filters through a shared search-history service. Pagination, prefetching, automated refreshes, health checks, and other non-user traffic must not create history entries.

## 12. Suggested system architecture

### Technology choices

- **Frontend:** React with TypeScript. Use a query/cache library for server state and a schema-driven form layer for source filters; all filtering, sorting, and pagination remain server-side.
- **Backend:** Node.js with TypeScript and NestJS (using its Fastify adapter) for the HTTP API and worker entry points. Sharing TypeScript schemas between the React client and API reduces filter-contract drift, while NestJS modules provide clear adapter, job, history, and persistence boundaries.
- **Persistence and jobs:** PostgreSQL for canonical data and constraints; Redis with BullMQ for durable background-job coordination. PostgreSQL remains the source of truth for job state, checkpoints, email uniqueness, and send history.

- **Web application:** authenticated operator and administration interface.
- **Application API:** validation, authorization, job control, record management, and progress endpoints.
- **Queue:** durable delivery of discovery and inspection batches.
- **Workers:** source access, normalization, deduplication, and persistence.
- **Relational database:** jobs, users, emails, suppressions, and audit events.
- **Cache/coordination store:** optional worker locks, throttling, and short-lived progress data.
- **Secret manager:** source credentials and signing/encryption keys.
- **Object storage:** optional encrypted, expiring export files; not required for core collection.

The source collector must use the adapter contract defined in [ARCHITECTURE.md](./ARCHITECTURE.md), so permitted APIs or source behavior can change without rewriting job orchestration or record management.

## 13. Security, privacy, and compliance

- Require authentication and role-based authorization for every page and endpoint.
- Use TLS, secure cookies, CSRF protection, output encoding, and standard security headers.
- Encrypt sensitive data at rest where supported; keep credentials exclusively in a secret manager.
- Never log access tokens, raw authorization headers, or unredacted secrets.
- Audit job creation, exports, record viewing where required, suppression, deletion, and permission changes.
- Apply configurable retention periods to source payloads, logs, exports, and stale personal data.
- Provide an opt-out/suppression process and prevent suppressed data from being recollected.
- Support deletion requests and document whether deletion is immediate or scheduled.
- Restrict exports by role, scope them to active filters, watermark/log them, and make download links expire.
- Define the lawful purpose and jurisdiction-specific obligations before production use.
- Review each source's terms and API policies before enabling it and whenever its adapter behavior changes.

## 14. Reliability and observability

- Structured logs with job, batch, worker, and request correlation IDs.
- Metrics for queue depth, batch latency, job duration, source response codes, rate-limit waits, retry counts, and result counts.
- Alerts for stuck jobs, sustained errors, credential failures, exhausted rate limits, and queue backlog.
- Health checks for the API, worker, queue, database, and source adapter.
- A reconciliation task should detect and recover abandoned running batches after worker failure.
- Backups must be encrypted and tested, and deletion/retention policy must account for backup lifecycle.

## 15. Acceptance criteria for MVP

1. An authenticated operator can select GitHub and create a job using location, language, follower range, public-email requirement, and maximum-user filters.
2. Job creation returns immediately and work continues through a background queue.
3. The job page updates state and counters without a full page refresh under normal browser support.
4. A worker can resume from its last persisted checkpoint after restart without duplicating records.
5. Publicly declared email addresses and associated source-account details are saved with provenance and timestamps.
6. When a direct email is unavailable, permitted linked-site/public-search enrichment can save inferred or guessed candidates with evidence; guessed candidates are visibly marked `unsure` and are never represented as publicly declared.
7. `email_addresses.normalized_email` is the primary key. Reprocessing or concurrently discovering the same normalized address atomically updates the existing record and provenance without creating a duplicate.
8. Operators can search, filter, sort, and paginate collected users and emails, including one-click filtering for records never successfully sent an email.
9. Successfully executed filters are stored per operator, can be reviewed and re-run, and cannot bypass current permissions.
10. Authorized users can export filtered active records; every export is audited, and unsure/guessed addresses are excluded by default.
11. Authorized users can suppress or delete a record, and suppressed identities are not recollected.
12. Operators can pause, resume, and cancel active jobs.
13. Rate-limit responses pause or slow work automatically and appear on the job page.
14. Permanent batch failures are visible without preventing all successful batches from being retained.
15. Secrets and sensitive headers do not appear in the UI, logs, database job configuration, search history, or error messages.
16. GitHub-specific API, pagination, and rate-limit logic exists only inside the GitHub adapter.
17. A test/dummy second adapter can be registered without changing shared job, user, or email tables.
18. The operator UI is implemented in React with TypeScript and remains usable for large result sets through server-side search, filters, sorting, and pagination.

## 16. Delivery phases

### Phase 1 — MVP

- Authentication and roles.
- Filtered job creation.
- Source-adapter registry and one approved GitHub adapter.
- Durable background processing and progress updates.
- User/email persistence, deduplication, management, export, suppression, and audit logging.
- Linked-website enrichment with email provenance/confidence review.
- User/email table search history and never-sent filters.

### Phase 2 — Operational maturity

- Improved retry/reconciliation tooling.
- Shareable filter presets and scheduled refresh jobs; personal executed-search history is part of Phase 1.
- Data freshness policies and change history.
- Richer dashboards, alerts, and source-health reporting.

### Phase 3 — Optional extensions

- Additional approved source adapters.
- Organization/team workflows.
- Integrations with downstream systems, each requiring explicit authorization, field mapping, and audit controls.

## 17. Open decisions before implementation

- Which GitHub access method is approved for production: official API only, or API plus explicitly permitted public pages?
- Which source is expected after GitHub, so adapter boundaries can be validated against a realistic second implementation?
- Which countries and legal bases govern collection, retention, opt-out, and export?
- What are the default per-job maximum, concurrency, freshness window, and retention period?
- Is email export required for the MVP, and which roles may reveal or export full addresses?
- Should progress use Server-Sent Events, WebSockets, or polling based on the chosen deployment platform?
- What authentication provider and hosting environment will be used?
- Which public web-search/enrichment provider is approved, and which domains or page types may it inspect?
- Which guess patterns, maximum candidate count, evidence threshold, and confidence-scoring rules are approved?
- What exact local-part case-normalization policy will be used for the global email primary key?
