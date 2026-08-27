# Project Specifications

This repository currently contains specifications for a local, single-operator public-contact collection and email-sending application. The MVP has no application login, bulk export, or automatic retention expiry.

- [Collection product specification](./github_spec.md) — filters, asynchronous collection, progress, persistence, and record-management requirements. GitHub is the first source, implemented through a source adapter.
- [Email-sending specification](./EMAIL_SENDING_SPEC.md) — recipient selection, Gmail settings, background sending, progress, sent-status tracking, and provider extensibility.
- [Overall architecture specification](./ARCHITECTURE.md) — shared domain model, adapter contracts, queues, workers, scaling, security boundaries, processing flows, and integration expansion.

GitHub and Gmail are the initial integrations, not hard-coded platform boundaries. Future websites and email providers must be added through the adapter contracts described in the architecture specification.
