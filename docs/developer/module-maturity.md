# Product Module Maturity and Evidence

OpenSlack tracks product lifecycle and delivery maturity as separate facts. The
canonical source is `.openslack/modules.yaml` in a source checkout and
`assets/product/modules.yaml` in a packaged installation.

## Fields

| Field                | Meaning                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `status`             | Product lifecycle: `planned`, `early`, `active`, or `retired`.                                                                     |
| `maturity`           | Evidence-backed delivery maturity: `planned`, `implemented`, `local_ready`, `live_verified`, or `production_ready`.                |
| `operatorConfigured` | Whether the documented reference operator environment is configured for this capability. It is not a probe of the current machine. |
| `externalBlockers`   | Named operator, hosted-service, credential, approval, or clean-machine gates that remain open.                                     |
| `evidenceRefs`       | Committed evidence supporting the maturity claim.                                                                                  |

Runtime diagnostics such as `openslack doctor` and `openslack agent-runtime
doctor` report the current machine. They must not silently rewrite the product
registry's `operatorConfigured` value.

## Maturity meanings

| Maturity           | Required interpretation                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `planned`          | Design intent only; implementation evidence has not been accepted.                                       |
| `implemented`      | Code and focused tests exist, but the complete local product path has not passed.                        |
| `local_ready`      | The supported local path and repository gates pass. This is not a live or production claim.              |
| `live_verified`    | A committed revision has passed the named real external-system or clean-machine evidence.                |
| `production_ready` | Live evidence exists, the reference operator environment is configured, and no external blockers remain. |

`LOCAL_READY` is rendered as a warning, never as `[PASS]`. Only
`LIVE_VERIFIED` and `PRODUCTION_READY` may render as passing maturity.

## Evidence references

Evidence references use one of these forms:

```text
commit:<7-to-40-hex-sha>
test:<repository-relative-path>
repo:<repository-relative-path>
branch:<git-ref-name>
```

For source-checkout verification, commit references must resolve to ancestors
of the current `HEAD`. Repository and test paths must exist and be tracked by
Git. Every maturity above `planned` requires evidence. `live_verified` and
`production_ready` additionally require at least one valid commit reference in
addition to any test or repository evidence. Every declared repository/test path
must exist at a declared evidence commit; staged or working-tree-only content is
not accepted.

Live and production claims also require a committed
`repo:.openslack/evidence/live/<id>.json` record with schema
`openslack.live_evidence.v1`. The record must name the owner module/component,
tested commit, passing outcome, external environment, observation time, and
expiry time. It must also carry a correlation ID, a revision equal to the tested
product commit, and at least one redacted evidence reference. Empty trace fields,
revision mismatches, credential-shaped evidence references, control characters,
and fields longer than 512 characters fail closed. `observedAt` may be at most
five minutes ahead of the verifier's clock and may not precede the tested commit
time by more than the same five-minute clock-skew allowance. The record must
still be unexpired, and its validity window may not exceed 30 days.

`testedCommit` identifies the product revision that actually passed the live or
clean-machine run. It must be an ancestor of both the declared evidence commit
that contains the record and the current `HEAD`. Every path changed between the
tested revision and `HEAD` must be evidence/status metadata from this strict
allowlist:

```text
.openslack/evidence/live/*.json
.openslack/modules.yaml
docs/status/current.md
```

This permits the evidence record, registry promotion, and generated status to be
committed after the tested run without creating a commit-hash cycle. Any later
code, workflow, policy, build, or ordinary documentation change makes that live
evidence stale and requires a new run against the new product revision. Expired,
future-dated, overlong, stale-code, and ordinary implementation evidence cannot
promote a module to live maturity.

Component maturity caps its owning module. For example, a locally ready Agent
Runtime component prevents the Collaboration Layer from claiming live or
production maturity.

## Compatibility and deferred work

Readers accept `openslack.modules.v1` only as an input compatibility format. A
v1 module is migrated conservatively to `planned`, with
`maturity_evidence_not_audited` as a blocker. Lifecycle status is never used to
infer maturity.

Work that is intentionally outside the standalone product baseline belongs in
`deferredWork`. Deferred items must set `countedTowardStandalone: false` and
cannot claim maturity above `local_ready`. The Negentropy-Lab sidecar is tracked
this way until its separate branch is governed and merged. The `branch` field is
a locator, not maturity evidence. A deferred `branch:` evidence reference, when
used, must resolve and match that field. A local-only branch remains solely in
the locator field until it is published; it must not be presented as portable
evidence. The durable Sidecar evidence is its ancestor-bound committed ledger
path; branch metadata cannot promote a normal module or component by itself.

Run these checks after changing the registry or evidence:

```bash
openslack status generate
openslack status verify
```

`status verify` validates the v2 source, evidence references, component caps,
deferred-work boundaries, and exact reproducibility of `docs/status/current.md`.
