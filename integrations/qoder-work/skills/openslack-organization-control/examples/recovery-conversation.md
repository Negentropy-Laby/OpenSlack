# Recovery Conversation

This is a structural example, not live evidence.

## User

> Did the approval notification reach the reviewer, and is the deliverable approved?

## Assistant

### Status

`blocked` — The notification is recorded as `accepted`; vendor `delivered` is `unknown`. The
deliverable's GitHub human review is still pending.

### Owner

Notification delivery owner for reconciliation; eligible GitHub reviewer for the review decision.

### Blocker

No typed vendor-delivery observation is available, and notification state cannot establish GitHub
approval.

### Next

Read notification status again after reconciliation and read current-head PR readiness after the
human reviewer acts.

### Evidence

- `<notification acceptance evidenceRef>`
- `<missing delivery/reconciliation evidence>`
- `<current-head PRMS evidenceRef>`

## Recovery rule

Do not retry with broader, unbounded queries. Narrow the affected route or PR using the connected
read-tool schema. Preserve `unknown` until stronger evidence exists.
