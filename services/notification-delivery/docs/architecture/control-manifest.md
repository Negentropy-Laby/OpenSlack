# Architecture Control Manifest

> **Status**: Approved design controls
> **Evidence level**: implemented, mechanically verified and independently Approved

| ID | Binding control | Authority | Intended enforcement | Planned evidence |
|---|---|---|---|---|
| CTRL-001 | intake identity, payload and outbox visibility commit atomically | BL-03, ADR-0001 | Store transaction | integration + rollback injection |
| CTRL-002 | `(caller_id,idempotency_key)` deduplicates by canonical fingerprint; mismatch is 409 | BL-02, ADR-0002 | unique key + fingerprint compare | contract + concurrency |
| CTRL-003 | external delivery is at-least-once; duplicates remain possible | BL-03, ADR-0002 | lease recovery + public documentation | crash-after-send fault injection |
| CTRL-004 | only Store mutates notification, lease, attempt and replay state | Store CDD, ADR-0001 | repository ownership and DB grants | dependency + integration |
| CTRL-005 | only Registry mutates vendor/config/receipt/audit state | VR CDD, ADR-0001 | repository ownership and DB grants | dependency + integration |
| CTRL-006 | retryable actual result at/after cutoff dies in the current write and counts once | Delivery/Store B-01 | Delivery classifier + Store union | cutoff-epsilon contract/integration |
| CTRL-007 | no-send deadline termination is non-counting policy history | Delivery/Store CDD | pre-send policy path | logic + integration |
| CTRL-008 | attempts stop at 25 or one cycle reaches 24h | BL-04, Delivery CDD | Delivery policy | deterministic clock tests |
| CTRL-009 | every unstarted attempt reads the latest active vendor snapshot | VR/Delivery CDD | Registry snapshot port | integration + disable/rotate race |
| CTRL-010 | callers cannot supply a URL, transport Header or server identity | BL-02/05 | closed OpenAPI + composition | contract + security negative |
| CTRL-011 | ActorContext is server-derived and attenuated per internal call | ADR-0003 | Caller Access/composition | contract + security negative |
| CTRL-012 | revoked API keys fail immediately; authorization is rechecked on replay/admin retry | ADR-0003 | authoritative key read | integration + fault injection |
| CTRL-013 | all A/AAAA results must pass policy before any socket is opened | BL-05, ADR-0004 | safe transport preflight | DNS security negative |
| CTRL-014 | connection uses a validated pinned IP and original TLS hostname | ADR-0004 | custom dial/TLS configuration | rebinding + TLS negative |
| CTRL-015 | environment proxy is disabled and every redirect is rejected | ADR-0004 | dedicated HTTP transport | proxy/redirect negative |
| CTRL-016 | secret values, payload and response bodies never enter logs/metrics/audit | BL-05, ADR-0003/4 | structured allowlists | marker scan |
| CTRL-017 | replay is explicit, preview-first, version-checked and never automatic | BL-04, Operations CDD | operator composition + OCC | contract + replay race |
| CTRL-018 | metrics expose only depth, oldest pending age and dead count | BL-06, RO CDD | global Store projection | contract + security negative |
| CTRL-019 | collection failure emits no false zero/stale business sample | RO CDD | atomic sample publication | fault injection |
| CTRL-020 | PostgreSQL failure makes readiness false; no local fallback state exists | Architecture | lifecycle/readiness | dependency fault injection |
| CTRL-021 | public JSON success/error responses carry `request_id` in a stable envelope | OpenAPI | HTTP presentation layer | OpenAPI contract |
| CTRL-022 | cursors are opaque and bound to operation, effective scope and snapshot | Store/VR CDD, OpenAPI | signed cursor codec | contract + tamper negative |
| CTRL-023 | append-only attempts, endpoint versions and audit facts survive migrations | Data model | DB grants + forward migration | migration tests |
| CTRL-024 | no Kafka, Redis, independent DLQ, scheduler platform or service mesh in MVP | ADR-0001, technical preferences | dependency review | static architecture check |

Any implementation exception requires a CDD or ADR change before code merge. Executable evidence is indexed by
[`../testing/ac-evidence.json`](../testing/ac-evidence.json); runtime acceptance is summarized in
[`../testing/acceptance-report.json`](../testing/acceptance-report.json).
