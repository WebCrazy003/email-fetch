# Automated Email Sending — Product and Technical Specification

## 1. Purpose

Add a second-stage workflow that lets the local operator select one or more stored email addresses directly from the **Emails** page, choose a reusable email template, and send the rendered message automatically to every otherwise eligible selected address through a connected Gmail account.

The feature must run asynchronously, show sending progress, record the outcome for every recipient, and clearly mark successful and failed send results in the user and email management tables.

Gmail is the only sending provider in the first release. Sending orchestration and data models must remain provider-neutral so another approved provider can be added later through an adapter.

This specification depends on the records defined in [github_spec.md](./github_spec.md) and the platform boundaries defined in [ARCHITECTURE.md](./ARCHITECTURE.md).

## 2. Goals

- Select one email, several emails, or all email records on the current **Emails** page.
- Create, view, update, and delete reusable email templates.
- Choose a template for the selected email recipients and create an immutable campaign message snapshot from it.
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
- HTML email and scheduled sending.
- Automatic generation of message content.
- Sending to records that are suppressed, deleted, invalid, or no longer public.
- Treating a public email address as proof of consent or permission to send.

## 4. Local operator

- The MVP has one trusted local operator and no application login, roles, or sending permissions.
- The operator configures Gmail, selects recipients, sends tests, starts or controls campaigns, and views every recipient outcome.
- Gmail OAuth remains required because it authorizes access to the external Gmail account; it is not application-user authentication.
- The application must remain local-only unless authentication and authorization are added later.

## 5. Primary workflow

1. The operator opens the **Emails** table and applies any desired filters.
2. The operator selects one or several email rows, or uses the table-header checkbox to select all selectable email rows on the current page.
3. The operator chooses **Send email**.
4. The application creates an immutable selection snapshot and reports selected, eligible, suppressed, invalid, and previously sent counts.
5. The sender selects an active email template.
6. The application renders a preview from the selected template and representative recipient data, and reports any missing or invalid merge values.
7. The sender selects a connected Gmail sender account, or the application uses the configured default account when only one choice is needed.
8. The sender provides the campaign name, confirms the sender name and optional reply-to address, and may send a test email to an approved address.
9. A confirmation screen shows the selected template and version, final recipient count, duplicate policy, rate limits, and estimated duration.
10. The sender confirms **Send automatically**.
11. The API snapshots the selected template content, creates background recipient tasks, starts the campaign, and immediately returns a campaign ID.
12. Workers re-check eligibility immediately before each send, render recipient-specific merge fields from the template snapshot, and submit messages through the Gmail provider adapter.
13. The campaign page updates counters, recent errors, provider-limit status, and estimated completion.
14. When Gmail accepts a message, its recipient task becomes `sent` and the associated email record's sending summary is updated.
15. When a send receives a permanent error or exhausts its allowed retries, its recipient task and result become `failed`, and the associated email record's latest-attempt summary is updated with the failure.
16. The Emails table shows the latest send state and timestamp for each address.

## 6. Recipient selection

- Each email row has a selection checkbox. Rows that are deleted, suppressed, or syntactically invalid are visibly disabled and cannot be selected.
- Selecting an email adds its canonical `email_addresses.normalized_email` primary key to the pending selection, not a copied display string.
- The operator can select or deselect individual rows and can keep several rows selected at the same time.
- The table-header checkbox selects or deselects all selectable email rows returned on the current page. It does not implicitly select results on other pages.
- The table-header checkbox is checked when every selectable row on the page is selected and indeterminate when only some are selected.
- Changing pages or filters must clearly preserve the explicit selected-address count or offer a deliberate **Clear selection** action; it must never silently add newly visible addresses.
- **Send email** is disabled until at least one address is selected.
- Starting the send workflow resolves the selected canonical email IDs into an immutable recipient snapshot before review.
- The UI must show excluded counts and reasons before confirmation.
- Only explicitly selected email rows are included. Selecting one address does not automatically include other addresses belonging to the same person.
- The review screen displays each selected address's confidence, discovery type, linked person, and current send status without using confidence as an eligibility gate.
- Duplicate normalized addresses collapse to one campaign recipient. When one address is linked to several users, the review groups all links and disables person-specific merge fields unless the operator explicitly chooses the applicable person.
- Changes to the source table after snapshot creation do not silently add recipients.
- Suppression, deletion, validity, and prior-send rules are re-evaluated just before sending.

## 7. Eligibility and duplicate-send rules

An address is eligible only when:

- The record exists and its status is `active`.
- It has not been deleted or suppressed.
- Its person, source account, domain, and normalized email are not suppressed.
- It passes any configured validity requirement.
- Confidence does not determine eligibility. An explicitly selected `confirmed`, `likely`, `unsure`, or guessed address may be sent, but confidence and discovery type must remain visible during review.
- It satisfies the selected campaign's legal-purpose or consent policy fields.
- It is not blocked by the campaign's duplicate-send policy.

Default duplicate policy:

- Never send the same campaign to the same normalized email more than once.
- A retried task with the same idempotency key must not create a second message.
- If the recipient was successfully sent before a timeout or worker crash, reconciliation must check the stored provider message ID before retrying.
- A new campaign must not send to an address that was successfully contacted by any earlier production campaign.

## 8. Campaign and recipient states

### Campaign states

- `draft`
- `validating`
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

The local operator configures:

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
- Repeat contact is disabled.
- Test-recipient allowlist for non-production environments.

Raw client secrets and refresh tokens must be stored in a protected local credential file or encrypted credential store. They must never be returned to the browser, written to logs, or stored in generic settings JSON.

### Gmail account connection

The **Settings → Email Providers** page must support:

- **Connect Gmail account** using OAuth authorization.
- Display connected email address, connection owner, granted scope, and connection time.
- Display connection health and most recent successful/failed API check.
- Send a test message.
- Reauthorize an expired or revoked connection.
- Disable or disconnect an account.
- Only one Gmail account may be connected in the MVP; connecting another replaces the previous connection after OAuth confirmation.

Disconnecting an account prevents new sends but does not remove historical campaign records.

### Provider limits

- The platform enforces configurable defaults of 100 messages per rolling 24 hours, 20 messages per rolling hour, and at least five seconds between submissions.
- Workers must recognize quota/rate-limit responses, stop claiming new tasks for that account, and set affected campaigns to `provider_limited`.
- The UI must show the reason and the next retry time when available.
- Limits are tracked per connected sender account and globally.
- A sender cannot bypass caps by repeatedly pausing, cloning, or recreating a campaign.

## 10. Email templates and message composition

### Template management

The application adds an **Email Templates** page for reusable message content. The local operator can:

- Create a template.
- List and view existing templates.
- Edit a template's name, description, subject, plain-text body, and allowlisted merge fields.
- Duplicate an existing template as a starting point for a new template.
- Delete a template after confirmation. Deletion is implemented as a soft archive so send history remains intact.

Template rules:

- Template name, subject, and plain-text body are required. Template names must be unique among active templates.
- Templates are plain text in the MVP.
- Supported merge fields are selected from an explicit allowlist, such as recipient display name, source username, and email address.
- Preview validation must report unknown variables and missing required fallbacks before a template can be used for sending.
- Every successful template update increments its revision number so the selected content can be identified during review.
- Deleting a template archives it and prevents its use in new campaigns but does not alter campaign snapshots or historical send records.
- A template is provider-neutral and cannot contain Gmail credentials or provider-specific API data.

### Campaign message composition

Required fields:

- Campaign name.
- Active email template and template revision.
- Connected sender account.
- Sender display name.
- Purpose or campaign classification.

Optional fields:

- Reply-to address; when omitted, replies go to the connected Gmail sender.

Rules:

- The campaign subject and plain-text body come from the selected template.
- Selecting a different template replaces the draft campaign preview only after explicit confirmation.
- Subject and body length must be validated both when saving a template and when creating the campaign snapshot.
- Unknown or missing merge variables fail preview validation or use an explicitly configured fallback.
- Header values must be protected against newline/header injection.
- Every message must contain sender identification and required opt-out information.
- Template ID, revision, subject, plain-text body, and merge-field rules are copied into the campaign. Later template edits or deletion cannot change a draft after confirmation or a queued, sending, or completed campaign.
- The confirmation action starts automatic background sending; the browser must not remain open for the campaign to continue.
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
- Sender account, creation time, start time, and completion time.
- Total selected and total eligible.
- Queued, sending, sent, retrying, failed, skipped, and cancelled counts.
- Percentage complete when the final task count is known.
- Current application and provider throttling status.
- Estimated completion time when meaningful.
- Sanitized recent event/error log.
- Paginated recipient table with outcome, attempts, last error category, and sent time.

Status updates use Server-Sent Events, with polling as a fallback. Counters must come from persisted or reconcilable state rather than browser memory.

## 13. Emails page and sending-status changes

The **Emails** page adds:

- A checkbox for each selectable email row.
- A table-header checkbox for selecting all selectable rows on the current page.
- A persistent selected-count indicator and **Clear selection** action.
- A **Send email** action that opens template selection and campaign review.
- Confidence, discovery type, linked user, eligibility, and previous-send status in the selection context.

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
- Hover or detail view shows the last sent time and campaign.
- The Emails table can filter by never sent, sent, failed latest attempt, campaign, and sent-date range.

The table summary may be stored as denormalized fields for performance, but campaign-recipient history remains the source of truth and must be repairable by reconciliation.

## 14. Data model

### `email_templates`

- `id`
- Unique active template name and optional description
- Subject
- Plain-text body
- Allowlisted merge-field configuration and fallback values
- Revision number
- Status: active or archived
- Created, updated, and archived timestamps

### `email_provider_connections`

- `id`
- Provider key, initially `gmail`
- Connected account address and external account ID
- Display label
- Encrypted credential reference
- Granted scopes
- Status: active, unhealthy, revoked, or disabled
- Configured rate/campaign limits
- Last health-check and last error metadata
- Created, updated, and disconnected timestamps

### `email_campaigns`

- `id` and name
- Template ID and selected template revision
- Immutable template snapshot containing subject, plain-text body, and merge-field rules
- Provider connection ID and provider adapter version
- State
- Sender name, sender address, and reply-to
- Subject and plain-text body
- Purpose/policy metadata
- Duplicate policy
- Selected-email ID snapshot and selection counts
- Start, completion, and cancellation timestamps
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
- Unique active email-template name and an index on template status and updated time.
- Unique provider idempotency key.
- Index recipient state and next retry time for worker claiming.
- Index campaign state and creation time.
- Index `email_addresses.last_sent_at` and successful-send count for table filters.
- Historical recipient rows retain their address snapshot until the operator manually deletes the related campaign or data; the MVP has no automatic retention expiry.

## 15. API outline

- `POST /api/email-campaigns/selections` — resolve explicitly selected canonical email IDs into a preview snapshot.
- `POST /api/email-campaigns` — create a draft from a validated email selection and active template revision.
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
- `POST /api/email-templates` — create a template.
- `GET /api/email-templates` — list active templates, with an explicit option to include archived templates.
- `GET /api/email-templates/{id}` — retrieve a template and its current revision.
- `PATCH /api/email-templates/{id}` — update a template and advance its revision.
- `POST /api/email-templates/{id}/duplicate` — create a new template from an existing one.
- `DELETE /api/email-templates/{id}` — soft-delete a template by archiving it after validation and confirmation.
- Local-only provider connection, OAuth callback, health-check, and limit endpoints.

Starting, testing, and other retry-prone mutations require idempotency keys. All endpoints require server-side validation and must be reachable only through the local application boundary.

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

- Public availability of an address does not by itself establish consent or a lawful basis for outreach.
- Store the campaign purpose and applicable permission/legal-basis metadata before sending.
- Apply global, source, person, email, and domain suppressions at selection and immediately before send.
- Every production message includes a reply-based opt-out instruction. The operator manually processes opt-out replies with the Emails-page suppression action before sending another campaign.
- Never send to a suppression entry even if it remains in an old campaign snapshot.
- Limit campaign size and sending rate, with stricter defaults for new accounts.
- Audit selection, previews, tests, campaign confirmation, state changes, sends, and provider-setting changes.
- Encrypt OAuth credentials and minimize access to message bodies and recipient history.
- Redact tokens and unnecessary personal data from logs and errors.
- Do not automatically expire campaign bodies, address snapshots, or provider identifiers in the MVP; retain them in the local database until manual deletion.
- Require a policy and legal review before production outreach in each target jurisdiction.

## 18. Reliability and observability

- Metrics for queued recipients, send rate, provider latency, success rate, retry rate, failure categories, quota waits, and campaign duration.
- Alerts for revoked credentials, abnormal failure/bounce signals, stalled campaigns, repeated retries, and unexpected volume.
- Structured logs include campaign, recipient-task, worker, provider-connection, and correlation IDs, but not raw tokens or full message bodies.
- Reconciliation verifies projection counters and repairs user/email table summaries.
- Local backups are operator-managed and may retain manually deleted records until the operator removes those backups.

## 19. MVP acceptance criteria

1. The local operator can select one or several eligible email rows directly from the **Emails** page.
2. The Emails table header can select or deselect every selectable email on the current page without selecting email records on other pages.
3. Only explicitly selected email addresses are included; selecting an address does not automatically include other addresses belonging to the same person.
4. The application displays excluded and eligible counts before a campaign is confirmed.
5. The local operator can create, list, view, edit, duplicate, and delete email templates; deletion is a history-preserving soft archive.
6. Editing or deleting a template does not change a campaign's immutable template snapshot or historical recipient records.
7. After selecting emails, the operator can choose an active template, preview rendered content, choose the Gmail sender, and confirm automatic sending.
8. The local operator can connect, test, disable, reauthorize, and disconnect a Gmail account through settings.
9. A sender can preview a template and send a test without marking a production recipient as sent.
10. Confirming **Send automatically** returns immediately while durable background tasks send the selected template snapshot to all eligible selected recipients, even if the browser is closed.
11. Campaign status and recipient counters update on the web page without a full refresh under normal browser support.
12. Gmail acceptance stores the returned provider message ID, marks the recipient task `sent`, and updates the email's last-sent summary.
13. A permanent provider failure or retry-exhausted transient failure marks the campaign-recipient state and result `failed`, records the failure category and timestamp, increments the failed counter, and shows **Failed** as the email's latest send result.
14. Successfully sent records show **Sent**, last-sent time, and last campaign in the Emails table and relevant user detail views.
15. A failed latest result remains **Failed** even when an earlier campaign succeeded; the UI also preserves and displays the earlier successful-send history.
16. Suppressed, deleted, invalid, and disallowed repeat recipients are skipped even if they were eligible when initially selected.
17. A worker restart or duplicate task delivery does not resend a successfully completed campaign recipient.
18. Transient failures retry with backoff and remain `retry_wait` until retries are exhausted; terminal failures remain visible without blocking other recipients.
19. Pausing stops new sends, resuming continues remaining tasks, and cancelling leaves already sent messages unchanged.
20. Provider limits slow or pause the campaign and are visible to the sender.
21. Every template change, test, campaign start, successful send, failure, cancellation, and provider-setting change is auditable.
22. Gmail-specific behavior exists only inside the Gmail provider adapter, and a dummy second provider can be registered without changing campaign tables or shared orchestration.
23. An explicitly selected `unsure` or guessed email is sent when it otherwise passes suppression, deletion, syntactic-validity, and repeat-contact checks.

## 20. Open decisions before implementation

- Must recipients have recorded consent, another documented lawful basis, or a source-specific outreach permission?
