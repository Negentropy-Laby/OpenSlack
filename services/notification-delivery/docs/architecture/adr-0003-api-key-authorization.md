# ADR-0003: API Key Identity, Scope and Capability

## Status

Accepted

## Date

2026-07-20

## Summary

Use high-entropy Bearer API keys for MVP. Server-owned principal records derive identity, kind, vendor scope and
capabilities; every downstream context is attenuated to the exact operation.

## Context

The service is internal and has no shared IdP requirement in the assignment. It still needs revocation, rotation,
least privilege, enumeration safety and separate caller/operator actions; vendor administration is a closed operator
capability set. Accepting caller-supplied identity or capabilities would collapse the trust boundary.

## Decision

- Key format: `key_id.secret`, with a 256-bit random secret shown only once.
- Persist only `HMAC-SHA-256(pepper_for(row.pepper_id), full_key)` plus key/principal metadata and the non-secret `pepper_id` label; constant-time comparison. The pepper lifecycle (rotation, recovery, invalidation) is governed by the bullets below.
- `Authorization: Bearer <key>` is the only business/admin auth scheme.
- Principal kind, scope and capabilities come from the authoritative record; request claims cannot add them.
- Composition creates different Store/Registry contexts and only required capabilities.
- Support revoke, expiry and rotation with at most two active keys per principal.
- Per-principal in-memory token bucket is acceptable for single-process MVP; it is not a global quota guarantee.

Pepper lifecycle (amendment 2026-07-20):

- (a) The HMAC pepper is a deployment-supplied >=256-bit high-entropy secret loaded once at startup from the
  `env://`-allowlisted config; changing either pepper generation requires a restart (residual risk per threat-model.md).
- (b) `access_keys` carries a non-secret `pepper_id` recording which pepper generation produced its digest (see
  `data-model.md`). Authenticate resolves the row by the public `key_id`, reads `pepper_id`, computes
  `HMAC-SHA-256(pepper_for(pepper_id), full_key)` and compares in constant time; because `pepper_id` is keyed on the
  public `key_id`, digest verification introduces no secret-dependent timing.
- (c) At most two pepper generations are live: `active` (used by all new issue/rotate writes) plus an optional
  `previous` (verify-only grace window).
- (d) Routine rotation deploys `active=new` with `previous=old` and restarts; new keys record the new `pepper_id`,
  existing keys continue to verify under their recorded `pepper_id`, and operators rotate principal keys at leisure
  under the existing at-most-two-active-keys rule. `previous` may be dropped once zero non-revoked keys reference it
  (count query). Draining `previous` is a precondition for the next routine rotation: a second rotation begun before
  the drain leaves non-revoked keys referencing a dropped pepper, so startup fails closed.
- (e) Emergency rotation (pepper compromise): (1) freeze `manage_access_keys` (no issue/rotate) to close the
  concurrent-issuance race; (2) bulk-revoke every key whose `pepper_id` is the compromised generation in one Store
  transaction (status -> revoked) — at commit, zero-staleness holds and the next authentication of a revoked key
  returns `401` immediately, because authenticate reads the authoritative `status`, not the pepper (CTRL-012/CA-10),
  so no restart is needed for revocation; (3) if the bulk-revoke commit outcome is unknown, re-query the count of
  non-revoked keys with that `pepper_id` to confirm it landed (CA-15 convergence); (4) deploy the new pepper as
  `active`, drop the compromised generation entirely (no grace for a compromised secret), and restart so the burned
  pepper leaves memory — a non-compromised `previous` generation, if one is live, MAY be retained through the emergency
  so its active keys are not orphaned;
  memory; (5) re-issue, then unfreeze. Honest residual: between commit and restart the in-flight process still holds
  the burned pepper in memory — it cannot authenticate revoked keys, but a key issued under the burned `pepper_id` in
  that window (only possible if the freeze is violated) would survive revocation (status=active) and trigger startup
  fail-closed on restart because its `pepper_id` is no longer loaded.
- (f) Pepper loss or unavailability makes startup fail-closed (readiness false, authentication `503`, never a stale
  success). Recovery dependency: the pepper is stored in a secret store whose backup is separate from the database
  backup and uses separate credentials; if both primary and backup are unrecoverable, generate a new pepper and treat
  it as compromise-equivalent (full re-issuance).
- (g) The pepper value is a CTRL-016 secret: it is never persisted in the database (only the non-secret `pepper_id`
  label is), and never enters logs, metrics, audit or API responses.
- (h) The global unique-HMAC-digest constraint is unchanged: different peppers yield different digests, and
  HMAC-SHA-256 collision resistance keeps global uniqueness valid.

## Alternatives

| Alternative | Decision |
|---|---|
| JWT/OIDC | Deferred until a real organization IdP/issuer/audience contract exists |
| mTLS identity | Deferred until a service-mesh/PKI operating model exists |
| plaintext or reversible key storage | Rejected |
| one super-admin/service context | Rejected; violates attenuation and hides boundary errors |

## Consequences

The MVP remains simple and revocable; key distribution remains a deployment responsibility, while the HMAC pepper
**lifecycle** (rotation, recovery, invalidation) is specified in the Decision section above and instantiated (concrete
secret source, operator commands, drill cadence, backfill labeling) by the deployment package. Routine rotation adds a
two-secret startup dependency with fail-closed semantics; emergency rotation is a service-wide API-key outage until
re-issue (inherent, not designed away); blast-radius reduction materializes only after the first routine rotation
establishes a second `pepper_id` (honest residual). Multiple replicas require a shared limiter if an exact aggregate
rate becomes necessary.

## Validation

Invalid/expired/revoked key tests, constant-time digest comparison review, scope/capability matrix tests, preview to
execute revocation, Store/Registry context non-interchangeability and enumeration-safe errors.

Pepper lifecycle (amendment 2026-07-20), mapped to existing test types now that `migration` is planned for the
CALLER-ACCESS family:

- MIGRATION: the additive `pepper_id` backfill preserves every existing digest (upgrade-from-previous + clean
  bootstrap), per the `data-model.md` Migration Principles.
- LOGIC/CONTRACT: `active` verifies; `previous` verifies during the grace window; a referenced `pepper_id` with no
  loaded pepper makes startup fail-closed; `pepper_id` selection is never secret-dependent in timing.
- INTEGRATION: routine rotation end-to-end (deploy active+previous, restart, issue a new key, old key authenticates
  under `previous`, rotate principal keys, confirm zero references via count query, drop `previous`).
- CONCURRENCY: a key issued during rotation records the target `pepper_id` atomically with its digest in one
  transaction (reuses the principal-row serialization pattern).
- SECURITY_NEGATIVE: marker scan asserting the pepper **value** is absent from logs, metrics, audit and responses;
  only the non-secret `pepper_id` label may appear.
- FAULT_INJECTION: emergency rotation — freeze `manage_access_keys`, bulk-revoke the compromised generation in one
  Store transaction, the next auth of a revoked key returns `401` at commit (auth reads DB status, not the pepper);
  commit-outcome-unknown re-queries the non-revoked count with that `pepper_id` (CA-15); a key issued under the
  burned `pepper_id` after commit, when the freeze is violated, survives revocation and triggers startup fail-closed.

## CDD Requirements Addressed

Caller Access CA-01..15, Vendor Registry ActorContext matrix, Store ActorContext rules, Operations authorization and
replay re-authentication.

## Dependencies

Depends on ADR-0001 principal/key persistence.

## Amendments

- **2026-07-20** — Pepper rotation/recovery/invalidation lifecycle spec added (Decision bullets, Consequences,
  Validation); `pepper_id` column added to `access_keys` (`data-model.md`, logical-schema design note — no migration
  files created in this slice). Re-reviewed under `architecture-review-archive.md`（2026-07-21 consolidation 前为
  `architecture-review-2026-07-20-advisory-closures.md`）. The original
  acceptance date 2026-07-20 is preserved. This supersedes the prior "the HMAC pepper are deployment responsibilities"
  wording **for the pepper lifecycle only**; key distribution remains a deployment responsibility, and platform
  instantiation (concrete secret source, operator commands, drill cadence, backfill labeling) remains a
  deployment-package obligation.
