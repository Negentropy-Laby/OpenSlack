# Notification Delivery Service Integration

> **Status:** IB0 contract baseline — `G0_CONTRACT_PASS_WITH_RC_REVIEW_WAIVER`
>
> **Runtime effect:** None. The v2 parser and protocol contracts are not wired into the watch daemon.
>
> **Target release:** OpenSlack 0.3.0

This document freezes the boundary between OpenSlack's GitHub Watch queue and the process-isolated notification
delivery service currently developed in `wsman/rc_wsman`. It is the OpenSlack half of Integration B0. The contract
gate passed with the narrowly scoped standalone-service review waiver described below; G1 service and G2 client
implementation may proceed without changing the runtime authority boundary.

## Baselines And Release Isolation

| Role                                          | Commit                                     | Tree                                       |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| OpenSlack 0.2.0 code-delivery evidence anchor | `e2eb615d37fe5e2861d6e90e6382ee6c34ff3ede` | `0db4739bfe63df46572db583baeaaaa727e1e2a1` |
| OpenSlack integration development base        | `cdf1cbc629273b89f1737a6efc4e8325e7c9ebfb` | `c62f6643c0f8fe966bb463c0b585b1b496fcdba2` |
| notification service review baseline          | `7976962e7de1c6ffcd234d2962b89dc4b23c95c0` | `ad742f2295c70af27d67173b248f7ae151e7faf9` |

The first value remains the 0.2.0 evidence anchor, not the integration branch point. IB0 through IB5 stay on the
protected `integration/notification-delivery-0.3` branch while 0.2.0 finishes signing, npm publication,
clean-machine delivery and live-capstone gates on `main`. Full service history is imported only after those release
gates and the 14-day Canary pass.

## G0 Review Governance

The original contract changes entered their repositories through OpenSlack merge commit
`5f71f91` and standalone-service merge commit `1b68cb6`. The service change passed its required CI but did not have
an independent approval. The release owner accepted that absence as a temporary, repository-scoped waiver rather
than representing it as independent review.

While `wsman/rc_wsman` remains the standalone deployment source, its integration changes require a pull request,
the configured required CI checks, an up-to-date head and a merge commit, but require zero approvals. Its protected
`main` permits no direct pushes, squash or rebase merges, force pushes, deletion or bypass. This waiver does not relax
technical tests, evidence requirements or any OpenSlack repository control.

OpenSlack implementation pull requests are agent-authored and target the protected
`integration/notification-delivery-0.3` branch. They require `wsman`'s independent current-head approval, all required
checks and resolved review threads; a new head dismisses stale approval. Only merge commits are allowed, and the
protected integration branch permits neither force push nor deletion. The waiver applies only to the standalone
service repository and expires at IB6: once the service history is imported, all service changes are governed by the
OpenSlack review policy. It cannot be used to bypass G1 through G8, CODEOWNERS, security review, release-owner
authorization or destructive-operation approval.

## Authority Transfer

```text
GitHub event
  -> durable OpenSlack event
  -> immutable final vendor bytes
  -> content-addressed local Blob
  -> durable route queue reference
  -> POST /v1/notifications
  -> strict 202 receipt persisted locally
  -> service PostgreSQL outbox
  -> vendor
```

- OpenSlack cannot POST until the Blob and route reference are durable.
- Before a valid receipt is durable, OpenSlack retries with the same key.
- After the queue contains `accepted`, the service permanently owns vendor delivery for that route record.
- Accepted records never fall back to direct delivery and are never re-rendered or rerouted.
- Service status is a read-only projection. It does not transfer authority back to OpenSlack.
- `NotificationServiceClient` will be a separate client and will not implement `NotificationSink`; a 202 never emits
  `notification.sent`.

## V2 Watch Configuration

The v1 parser and `github-watch.schema.json` remain unchanged. IB0 adds a separate
`openslack.github_watch.v2` parser and schema, but the daemon does not load them yet.

```yaml
schema: openslack.github_watch.v2
notification_service:
  endpoint: https://notification.internal
  credential_ref: keychain:openslack/notification-service
  expected_deployment_digest: sha256:<64-lowercase-hex>
repositories:
  - owner: Negentropy-Laby
    repo: OpenSlack
    events: [issues.opened]
    routes:
      - id: console-local
        sink: console
        delivery:
          backend: local
          routing_epoch: 1
      - id: slack-primary
        sink: slack
        channel: C123
        delivery:
          backend: notification_service
          vendor_id: openslack-slack
          routing_epoch: 1
```

Rules:

- Every v2 route has an ID matching `^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$`, unique in its canonical repository.
- Every route has a positive safe-integer `routing_epoch`, initially 1.
- `console` uses only `local`; `slack` and `webhook` use `direct` or `notification_service`.
- A service route requires a vendor ID matching `^[a-z0-9-]{1,64}$` and the root service block.
- Service endpoint is an HTTPS origin without userinfo, path, query or fragment. HTTP is accepted only for loopback
  when `allow_insecure_loopback: true` is explicit.
- `localhost` is resolver-dependent even in development; prefer literal `127.0.0.1` or `[::1]` for an explicitly
  enabled insecure loopback endpoint.
- Credential values never enter config. References use the existing `env:` or `keychain:` contract.
- Backend, vendor, target, encoder, response policy, idempotency mapping or other incompatible delivery semantics
  require a higher epoch. Existing queue records retain their frozen values.

## Handoff Idempotency Key

The exact preimage is:

```text
UTF8("openslack.watch.handoff.v2") || 0x00 ||
UTF8(event_stable_key)             || 0x00 ||
UTF8(route_id)                     || 0x00 ||
ASCII(routing_epoch without leading zeroes)
```

Hash with SHA-256, use the first 16 bytes, set RFC 4122 variant and version nibble 5, then render lowercase
`8-4-4-4-12`. The payload digest is deliberately absent. A route/backend/vendor/encoder incompatibility changes the
epoch; a changed body under the same frozen key is an integrity conflict and must result in service 409.

`event_stable_key` must be non-empty and must not contain U+0000. `route_id` is already NUL-free by its canonical
pattern, and `routing_epoch` is canonical decimal ASCII, so the delimited preimage remains unambiguous.

The executable vectors live in
`packages/github/src/__fixtures__/notification-handoff/key-vectors.v1.json`.

## Route Record Identity

The local v2 queue and acceptance ledger use one deterministic route-record identity. It is derived after the
repository and route idempotency key have been frozen; it is not a user-configurable watch route field:

```text
preimage =
  UTF8("openslack.watch.route-record.v2") || 0x00 ||
  UTF8(canonical_repository)              || 0x00 ||
  UTF8(persisted_idempotency_key)

route_record_id = lowercase_hex(SHA-256(preimage))
```

`canonical_repository` must already equal the lowercase `canonicalFullName` returned by
`canonicalizeRepositoryName`; the derivation rejects case variants, surrounding whitespace, extra path segments and
U+0000 rather than normalizing them. `persisted_idempotency_key` must match the frozen lowercase UUID-like v5 handoff
key contract. During per-route v1 migration, the original v1 route key is copied unchanged and used as this input; it
is never recalculated with the v2 handoff-key formula.

The result is exactly 64 lowercase hexadecimal characters and is used directly as the receipt filename. Executable
vectors, including a copied-v1-key case, live in
`packages/github/src/__fixtures__/notification-handoff/route-record-id-vectors.v1.json`.

## Final Vendor Bytes

IB2 materializes final vendor bodies through pure, exported functions:

```text
Slack encoder:   openslack.slack_chat_post_message.v1
Webhook encoder: openslack.webhook_notification.v1
```

Slack uses UTF-8 `JSON.stringify({channel,text,client_msg_id})`; webhook uses UTF-8
`JSON.stringify(NotificationPayload)`. There is no BOM, trailing newline, reformatting or service-side
canonicalization. Slack field insertion order is exactly `channel`, `text`, `client_msg_id`; webhook stringifies the
original payload object directly without cloning, spreading, JCS or reparsing. Both materializers return the raw
bytes, SHA-256 digest, byte size, `application/json` media type and frozen encoder version.

Existing direct Slack and webhook sinks send those same bytes while retaining their existing URL, headers,
acknowledgement classification, v1 idempotency key and size behavior. The separate handoff admission validator
accepts at most 262144 decoded bytes, but no direct sink calls it. Exact Unicode, escaping, field-order and
262144/262145-byte vectors live in
`packages/github/src/__fixtures__/notification-handoff/final-body-vectors.v1.json`.

The service Slack endpoint uses bearer auth, `json_ack_v1` and no outbound idempotency mapping because
`client_msg_id` is already in the body. The webhook endpoint uses no auth, status-only acknowledgement, and maps the
ingress key to both `Idempotency-Key` and `X-OpenSlack-Idempotency-Key` without rewriting the body.

## Blob And Receipt Contracts

Future Blob path:

```text
.openslack.local/daemon/blobs/sha256/<first-2-hex>/<64-hex>
```

The publish sequence is create-only temp, write, file fsync, create-only publish, directory fsync, reopen and verify.
Directories are `0700`, files `0600`, symlinks and non-regular files are rejected. Queue metadata remains capped at
16 MiB; Blob storage defaults to 1 GiB with warning at 80%. A live reference is never evicted.

Receipt path:

```text
.openslack.local/daemon/notification-acceptance/<route-record-id>.json
```

`<route-record-id>` is the deterministic 64-character identity above; arbitrary filenames and config-supplied IDs
are not accepted.

The strict schema is `openslack.notification_acceptance.v1`. It contains route/repository/vendor/key identity,
notification and request IDs, accepted/replay timestamps, deployment digest and watch-config digest. It contains no
payload, endpoint or credential. The executable schema is
`packages/github/src/notification-handoff-v2.schema.json`.

Accepted persistence is ordered:

```text
validate receipt
-> queue accepted + embedded receipt + ledger=pending; fsync
-> create-only receipt file; fsync
-> queue ledger=committed; fsync
```

A crash after the first queue write only repairs the receipt ledger; it never sends again. Blob GC eligibility begins
only after `accepted + ledger=committed` and the seven-day accepted retention. Rejected, quarantined and handoff-dead
Blobs retain for 14 days. Missing retained bytes block manual retry rather than causing re-rendering.

## States, Retry And HTTP Results

```text
pending -> processing -> accepted
                     -> retryable -> processing
                     -> rejected
                     -> quarantined
                     -> handoff_dead
```

`accepted` is terminal for handoff ownership. Remote service projection is separately
`unknown | pending | delivered | dead`.

- First POST is attempt 1 and runs immediately.
- Failure after attempt `n` waits
  `min(1h, max(5s * 2^(n-1), valid Retry-After))`.
- No jitter is used.
- Deadline is 24 hours after Blob plus route reference become durable.
- Attempt 25 failure or the deadline, whichever occurs first, produces `handoff_dead`.
- A processing crash consumes the attempt because the request may have escaped.
- Governed recovery keeps the original key, vendor, Blob and encoder.

| Response                                     | State/result                 |
| -------------------------------------------- | ---------------------------- |
| strict 202 and matching deployment digest    | accepted                     |
| malformed/incomplete 202                     | retryable protocol error     |
| valid 202 with unexpected deployment digest  | quarantined                  |
| conflicting receipt identity                 | quarantined                  |
| other 2xx                                    | quarantined                  |
| 3xx                                          | rejected; redirects disabled |
| 408, 429, 5xx or temporary transport failure | retryable                    |
| 400, 401, 403, 404, 413                      | rejected                     |
| 409                                          | quarantined                  |
| other 4xx                                    | rejected                     |

Responses are capped at 16 KiB and raw bodies are never logged or persisted.

## Identity And Evidence

The service will provision separate scoped principals:

```text
openslack-handoff-caller: submit_notification only
openslack-canary-auditor: read_notifications only
```

The caller cannot query status and the auditor cannot submit, replay or administer. All 202 responses include
`X-Notification-Service-Deployment-Digest: sha256:<64-lowercase-hex>`, injected from the verified OCI image. OpenSlack
also records a secret-free RFC 8785/JCS watch-config digest and service-reported vendor config versions.

## V1 Migration And Gates

Migration is per route: completed becomes a tombstone, failed becomes a terminal archive, pending/retryable remains
v1 direct-owned, and processing waits for lease recovery before v1 drain. Legacy keys are copied, never recalculated.
Mixed deliveries retain independent route ownership. No v2 record can be claimed by both routers.

The next phases remain blocked by gates:

```text
G0-CONTRACT: PASS_WITH_RC_REVIEW_WAIVER; OpenSlack independently reviewed, standalone service owner waiver + PR/CI
G1-SERVICE: service v2 contract implemented and verified
G2-CLIENT: body, Blob, receipt and client components verified but not wired
G3-QUEUE: v2 queue/router and per-route migration verified
G4-E2E: two repositories x Slack and webhook fault matrix
G5-CANARY: 336 continuous hours + 100 distinct non-replay accepted keys
```

G0 unlocks G1 and G2 only; it does not authorize daemon wiring or traffic. Only after G5 and the immutable 0.2.0
release may the full service history enter OpenSlack. This document makes no production-readiness, live-verification
or integration-completion claim.
