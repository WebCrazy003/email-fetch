# Automated Email Sending — Product and Technical Specification

## 1. Purpose

Add a second-stage workflow that lets an authorized operator select stored email addresses, compose a message, and send it automatically to every eligible selected recipient through a connected Gmail account.

The feature must run asynchronously, show sending progress, record the outcome for every recipient, and clearly mark successful and failed send results in the user and email management tables.

Gmail is the only sending provider in the first release. Sending orchestration and data models must remain provider-neutral so another approved provider can be added later through an adapter.

This specification depends on the records defined in [github_spec.md](./github_spec.md) and the platform boundaries defined in [ARCHITECTURE.md](./ARCHITECTURE.md).

## 2. Goals

- Select one, many, or all filtered eligible email records for a send.
- Compose a subject and plain-text or HTML message.
- Queue sending work outside the web request lifecycle.
- Show live or near-live campaign and recipient status.
- Mark a recipient as sent only after Gmail accepts the message for sending.
- Mark a recipient result as `failed` when the send ends in a permanent failure or exhausts its allowed retries.
- Display prior sending status in both user and email tables.
- Avoid accidental duplicate sends.
- Respect suppressions, provider limits, application limits, and cancellation.
- Preserve an audit trail of who sent what, when, from which account, and to whom.
- Allow future sending-provider adapters without changing campaign behavior.

## 3. Non-goals for MVP

- High-volume newsletter delivery.
- Inbox placement or delivery guarantees.
- Automated replies or multi-step sequences.
- Open or click tracking.
- Attachment support.
- Automatic generation of message content.
- Sending to records that are suppressed, deleted, invalid, or no longer public.
- Treating a public email address as proof of consent or permission to send.

## 4. Roles and permissions

### Administrator

- Configures the Gmail integration and global sending limits.
- Grants or removes sending permissions.
- Can view all campaigns, recipient outcomes, and sending audit events.
- Can disconnect a Gmail account or disable sending globally.

### Sender

- Creates campaigns from eligible email records.
- Sends test messages.
- Starts, pauses, resumes, or cancels their campaigns as allowed.
- Views campaign and recipient status.

### Operator or Viewer

- Cannot send unless separately granted the Sender permission.
- May view sending status only to the extent permitted by their role.

## 5. Primary workflow

1. A sender opens the **Collected Users** or **Emails** table.
2. The sender filters the table and selects individual records, the current page, or all matching eligible results.
3. The sender chooses **Create email campaign**.
4. The application creates an immutable selection snapshot and reports selected, eligible, suppressed, invalid, and previously sent counts.
5. The sender selects a connected Gmail sender account.
6. The sender enters the sender name, optional reply-to address, subject, plain-text body, and optional HTML body.
7. The sender reviews a preview and sends a test email to an approved address.
8. A confirmation screen shows the final recipient count, duplicate policy, rate limits, and estimated duration.
9. The sender confirms the campaign.
10. The API creates background recipient tasks and immediately returns a campaign ID.
11. Workers re-check eligibility immediately before each send and submit messages through the Gmail provider adapter.
12. The campaign page updates counters, recent errors, provider-limit status, and estimated completion.
13. When Gmail accepts a message, its recipient task becomes `sent` and the associated email record's sending summary is updated.
14. When a send receives a permanent error or exhausts its allowed retries, its recipient task and result become `failed`, and the associated email record's latest-attempt summary is updated with the failure.
15. The user and email tables show the latest send state and timestamp.

## 6. Recipient selection

- Each row with an eligible active email has a selection checkbox.
- Selection is based on canonical `email_addresses.normalized_email` primary keys, not unnormalized copied address strings.
- **Select current page** selects only visible eligible rows.
- **Select all matching** stores the current server-side filter definition and resolves it into an immutable recipient snapshot before review.
- The UI must show excluded counts and reasons before confirmation.
- If a person has multiple email addresses, the default is one selected address per person. A sender may explicitly choose multiple addresses if policy permits.
- Duplicate normalized addresses collapse to one campaign recipient unless an administrator-approved override exists.
- Changes to the source table after snapshot creation do not silently add recipients.
- Suppression, deletion, validity, and prior-send rules are re-evaluated just before sending.

## 7. Eligibility and duplicate-send rules

An address is eligible only when:

- The record exists and its status is `active`.
- It has not been deleted or suppressed.
- Its person, source account, domain, and normalized email are not suppressed.
- It passes any configured validity requirement.
- Its confidence is `confirmed` or `likely` under the default policy. An `unsure` or guessed address is excluded unless an administrator-enabled campaign policy explicitly allows it and the review screen identifies it as uncertain.
- It satisfies the selected campaign's legal-purpose or consent policy fields.
- It is not blocked by the campaign's duplicate-send policy.

Default duplicate policy:

- Never send the same campaign to the same normalized email more than once.
- A retried task with the same idempotency key must not create a second message.
- If the recipient was successfully sent before a timeout or worker crash, reconciliation must check the stored provider message ID before retrying.
- A new campaign may send to an address previously contacted by another campaign only when the configured contact policy allows it.
- An explicit **allow repeat contact** option may be administrator-only and must show the last send date before confirmation.

## 8. Campaign and recipient states

### Campaign states

- `draft`
- `validating`
- `scheduled`
- `queued`
- `sending`
- `paused`
- `provider_limited`
- `cancelling`
- `cancelled`
- `completed`
- `completed_with_errors`
- `failed`

### Recipient states

- `selected`
- `queued`
- `sending`
- `sent`
- `retry_wait`
- `failed`
- `skipped_suppressed`
- `skipped_invalid`
- `skipped_already_sent`
- `skipped_policy`
- `cancelled`

`sent` means the Gmail API accepted the send request and returned a message identifier. It does not guarantee delivery, inbox placement, or that the address exists. Future delivery or bounce observations must use separate fields and must not rewrite the historical submission result.

`failed` is a terminal result for that campaign recipient. It is set only when the provider returns a permanent failure or a transient failure reaches the configured retry limit. A transient error that still has retries available remains `retry_wait`, not `failed`. The failed result must retain a sanitized failure category, failure timestamp, and final attempt count.

## 9. Gmail settings

### Application-level configuration

Administrators configure:

- Google OAuth client ID and client-secret reference.
- Authorized redirect URI.
- Required Gmail send scope.
- Integration enabled/disabled state.
- Global daily and hourly safety caps.
- Maximum campaign size.
- Maximum concurrent send workers.
- Minimum delay between messages and optional randomized jitter.
- Retry limit and backoff settings.
- Default sender name and reply-to address.
- Allowed sender accounts or Workspace domain, if applicable.
- Whether repeat contact is permitted and its cooldown period.
- Test-recipient allowlist for non-production environments.

Raw client secrets and refresh tokens must be stored in a secret manager or encrypted credential store. They must never be returned to the browser, written to logs, or stored in generic settings JSON.

### Gmail account connection

The **Settings → Email Providers** page must support:

- **Connect Gmail account** using OAuth authorization.
- Display connected email address, connection owner, granted scope, and connection time.
- Display connection health and most recent successful/failed API check.
- Send a test message.
- Reauthorize an expired or revoked connection.
- Disable or disconnect an account.
- Select a default account when more than one is allowed.

Disconnecting an account prevents new sends but does not remove historical campaign records.

### Provider limits

- The platform must enforce conservative configurable limits below provider limits.
- Workers must recognize quota/rate-limit responses, stop claiming new tasks for that account, and set affected campaigns to `provider_limited`.
- The UI must show the reason and the next retry time when available.
- Limits are tracked per connected sender account and globally.
- A sender cannot bypass caps by repeatedly pausing, cloning, or recreating a campaign.

## 10. Message composition

Required fields:

- Campaign name.
- Connected sender account.
- Sender display name.
- Subject.
- Plain-text message body.
- Purpose or campaign classification.

Optional fields:

- Reply-to address.
- Sanitized HTML body with a generated plain-text fallback.
- Per-recipient merge fields from an allowlist, such as display name or source username.
- Schedule date and time.

Rules:

- Subject and body length must be validated.
- HTML must be sanitized before storage and sending.
- Unknown or missing merge variables fail preview validation or use an explicitly configured fallback.
- Header values must be protected against newline/header injection.
- Every message must contain sender identification and required opt-out information.
- Templates are versioned or copied into the campaign so later template edits cannot change an approved campaign.
- A test send must be clearly marked as a test and must not change recipient records to `sent`.

## 11. Background processing

- Confirmation creates durable recipient tasks from the immutable selection snapshot.
- Tasks are claimed in bounded batches but each recipient has an independent outcome.
- Before submitting, a worker acquires an idempotency lock and re-checks all suppression and policy rules.
- The worker renders the recipient-specific message and calls the provider adapter.
- On acceptance, the worker saves the provider message ID and sent timestamp in the same logical transaction as the `sent` state.
- Transient errors use exponential backoff with jitter.
- Permanent errors and retry-exhausted transient errors atomically set the campaign-recipient state and result to `failed`, record the sanitized failure details and timestamp, increment the campaign's failed counter, and update the email's latest-attempt summary. They do not block unrelated recipients.
- Provider quota errors pause tasks for the affected sender account.
- Cancellation stops unsent tasks; it cannot recall messages already accepted by Gmail.
- Worker restarts must not reset completed recipients or resend them.
- A reconciliation process detects abandoned `sending` tasks and resolves them without blindly resending.

## 12. Status and progress

The campaign page displays:

- Campaign state and current phase.
- Sender account, creator, creation time, scheduled time, start time, and completion time.
- Total selected and total eligible.
- Queued, sending, sent, retrying, failed, skipped, and cancelled counts.
- Percentage complete when the final task count is known.
- Current application and provider throttling status.
- Estimated completion time when meaningful.
- Sanitized recent event/error log.
- Paginated recipient table with outcome, attempts, last error category, and sent time.

Status should update using Server-Sent Events or WebSockets, with polling as a fallback. Counters must come from persisted or reconcilable state rather than browser memory.

## 13. User and email table changes

Add these columns or optional table fields:

- **Email send status:** Never sent, Sent, Partially sent, Failed, or Suppressed.
- **Last sent:** timestamp of the latest successful send.
- **Send count:** count of successful non-test campaign submissions.
- **Last campaign:** link to the latest campaign involving the email.
- **Last failure:** optional short failure category when the latest attempt failed.

Display rules:

- A green **Sent** indicator is shown only when at least one recipient task for that email is `sent`.
- **Never sent** is shown when no successful non-test send exists.
- If the latest production campaign recipient reaches terminal `failed`, its result and the email's latest send status are **Failed**.
- A failed result does not erase an earlier successful campaign-recipient record or decrement the historical send count. When both exist, the UI displays **Sent previously — latest attempt failed** while the latest result remains **Failed**.
- For a person with several addresses, **Partially sent** means at least one active address was sent and at least one was not.
- Hover or detail view shows the last sent time and campaign without exposing message content to unauthorized viewers.
- Tables can filter by never sent, sent, failed latest attempt, campaign, and sent-date range.

The table summary may be stored as denormalized fields for performance, but campaign-recipient history remains the source of truth and must be repairable by reconciliation.

## 14. Data model

### `email_provider_connections`

- `id`
- Provider key, initially `gmail`
- Connected account address and external account ID
- Display label and owner
- Encrypted credential reference
- Granted scopes
- Status: active, unhealthy, revoked, or disabled
- Configured rate/campaign limits
- Last health-check and last error metadata
- Created, updated, and disconnected timestamps

### `email_campaigns`

- `id`, name, and creator
- Provider connection ID and provider adapter version
- State
- Sender name, sender address, and reply-to
- Subject, plain-text body, and sanitized HTML body
- Purpose/policy metadata
- Duplicate policy
- Selection-filter snapshot and selection counts
- Schedule, start, completion, and cancellation timestamps
- Progress counters
- Created and updated timestamps

### `campaign_recipients`

- `id`
- Campaign ID
- Person ID and `normalized_email` foreign key
- Normalized recipient address snapshot
- Merge-data snapshot containing only allowlisted fields
- State and skip/failure reason
- Terminal result: `sent`, `failed`, `skipped`, or `cancelled`, when processing is complete
- Attempt count and next retry time
- Idempotency key unique within the provider connection
- Provider message ID and provider thread ID, when returned
- Queued, first-attempt, and sent timestamps
- Failed timestamp and sanitized final failure category/code
- Created and updated timestamps

### `campaign_events`

- Campaign ID and optional recipient ID
- Level and event type
- Sanitized message and metadata
- Timestamp

### Email summary fields

The `email_addresses` table may include:

- `successful_send_count`
- `last_sent_at`
- `last_sent_campaign_id`
- `last_send_attempt_status`
- `last_send_attempt_at`

These are projections derived from campaign recipients, not replacements for history.

### Constraints and indexes

- Unique `(campaign_id, normalized_email)` unless an explicitly supported multi-message campaign requires otherwise.
- Unique provider idempotency key.
- Index recipient state and next retry time for worker claiming.
- Index campaign state, creator, and creation time.
- Index `email_addresses.last_sent_at` and successful-send count for table filters.
- Historical recipient rows retain their address snapshot according to retention policy even if the current record changes; deletion requirements may require redaction or irreversible hashing.

## 15. API outline

- `POST /api/email-campaigns/selections` — resolve selected IDs or a filtered selection into a preview snapshot.
- `POST /api/email-campaigns` — create a draft from a validated selection.
- `GET /api/email-campaigns` — list campaigns.
- `GET /api/email-campaigns/{id}` — campaign configuration and progress.
- `PATCH /api/email-campaigns/{id}` — edit a draft.
- `POST /api/email-campaigns/{id}/test` — send a test message.
- `POST /api/email-campaigns/{id}/start`
- `POST /api/email-campaigns/{id}/pause`
- `POST /api/email-campaigns/{id}/resume`
- `POST /api/email-campaigns/{id}/cancel`
- `GET /api/email-campaigns/{id}/recipients`
- `GET /api/email-campaigns/{id}/events`
- Administrator-only provider connection, OAuth callback, health-check, and limit endpoints.

Starting, testing, and other retry-prone mutations require idempotency keys. All endpoints require authorization and server-side validation.

## 16. Provider adapter contract

The shared sending service calls a provider adapter with operations equivalent to:

- `connect` and `handle_oauth_callback`
- `check_connection`
- `get_sender_identity`
- `send_message`
- `classify_error`
- `get_limit_state`, when supported
- `disconnect`

The adapter returns normalized results such as accepted, transient failure, permanent failure, authentication failure, and provider limited. Gmail-specific OAuth objects, message encoding, response bodies, and error codes must not leak into shared campaign logic.

## 17. Security, privacy, and abuse prevention

- Sending requires a separate explicit permission from record viewing or export.
- Public availability of an address does not by itself establish consent or a lawful basis for outreach.
- Store the campaign purpose and applicable permission/legal-basis metadata before sending.
- Apply global, source, person, email, and domain suppressions at selection and immediately before send.
- Include a functional opt-out mechanism where required and process opt-outs promptly.
- Never send to a suppression entry even if it remains in an old campaign snapshot.
- Limit campaign size and sending rate, with stricter defaults for new accounts.
- Audit selection, previews, tests, campaign confirmation, state changes, sends, exports, and provider-setting changes.
- Encrypt OAuth credentials and minimize access to message bodies and recipient history.
- Redact tokens and unnecessary personal data from logs and errors.
- Provide configurable retention and deletion behavior for campaign bodies, address snapshots, and provider identifiers.
- Require a policy and legal review before production outreach in each target jurisdiction.

## 18. Reliability and observability

- Metrics for queued recipients, send rate, provider latency, success rate, retry rate, failure categories, quota waits, and campaign duration.
- Alerts for revoked credentials, abnormal failure/bounce signals, stalled campaigns, repeated retries, and unexpected volume.
- Structured logs include campaign, recipient-task, worker, provider-connection, and correlation IDs, but not raw tokens or full message bodies.
- Reconciliation verifies projection counters and repairs user/email table summaries.
- Database backups and audit retention follow the privacy and deletion policy.

## 19. MVP acceptance criteria

1. An authorized sender can select individual emails, the current page, or all eligible records matching active filters.
2. The application displays excluded and eligible counts before a campaign is confirmed.
3. An administrator can connect, test, disable, reauthorize, and disconnect a Gmail account through settings.
4. A sender can create a subject and message, preview it, and send a test without marking a production recipient as sent.
5. Confirming a campaign returns immediately while durable background tasks send to all eligible selected recipients.
6. Campaign status and recipient counters update on the web page without a full refresh under normal browser support.
7. Gmail acceptance stores the returned provider message ID, marks the recipient task `sent`, and updates the email's last-sent summary.
8. A permanent provider failure or retry-exhausted transient failure marks the campaign-recipient state and result `failed`, records the failure category and timestamp, increments the failed counter, and shows **Failed** as the email's latest send result.
9. Successfully sent records show **Sent**, last-sent time, and last campaign in user and email tables.
10. A failed latest result remains **Failed** even when an earlier campaign succeeded; the UI also preserves and displays the earlier successful-send history.
11. Suppressed, deleted, invalid, and disallowed repeat recipients are skipped even if they were eligible when initially selected.
12. A worker restart or duplicate task delivery does not resend a successfully completed campaign recipient.
13. Transient failures retry with backoff and remain `retry_wait` until retries are exhausted; terminal failures remain visible without blocking other recipients.
14. Pausing stops new sends, resuming continues remaining tasks, and cancelling leaves already sent messages unchanged.
15. Provider limits slow or pause the campaign and are visible to the sender.
16. Every test, campaign start, successful send, failure, cancellation, and provider-setting change is auditable.
17. Gmail-specific behavior exists only inside the Gmail provider adapter, and a dummy second provider can be registered without changing campaign tables or shared orchestration.

## 20. Open decisions before implementation

- Must recipients have recorded consent, another documented lawful basis, or a source-specific outreach permission?
- Is repeat contact across different campaigns permitted, and what cooldown applies?
- What conservative daily/hourly caps and delay should apply per Gmail account?
- Can multiple Gmail accounts be connected, and who may use each one?
- Are HTML messages and merge variables required in the MVP?
- Is scheduling required in the MVP or only immediate sending?
- How will opt-out requests enter the suppression system?
- How long should message content, recipient snapshots, and provider identifiers be retained?
