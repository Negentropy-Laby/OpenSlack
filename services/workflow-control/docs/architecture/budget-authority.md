# GS9-E2 Workflow Budget Qualification Authority

GS9-E2 adds an isolated PostgreSQL qualification authority around the frozen
`workflow-budget-authority/v1` operational projection. It proves durable reserve, reject,
settlement, exact receipt, ledger, and reconciliation behavior. It does not reinterpret the E1
projection's TypeScript authority fields or route a production Workflow or provider call through
Go.

## Authority boundary

- TypeScript remains the sole production Workflow and budget authority and the only user-visible
  read source.
- A fixed, non-secret qualification `BudgetSeed` supplies the policy hash and three canonical
  limits when the first account is created. It is process composition, not HTTP input or a
  production policy source.
- Go owns only qualification records in `workflow_control_budget_*` and advances the existing
  GS9-B run head under the same immutable route and expected-run-revision CAS.
- Runner F2 supplies the durable evidence for an active resumed lease. The budget service
  owns the account, reservation, ledger, and settlement in PostgreSQL.
- The budget HTTP contract is unchanged. The generation-one binding is verified inside Go
  against the Workflow Control run and the persisted F2 stage and resolution.
- No production client, routing epoch activation, canary, fallback, migration of an existing run,
  or writer cutover is introduced.

## Durable model

Migration `000006_create_workflow_control_budget_authority` creates five tables:

- `workflow_control_budget_accounts` holds the current per-run account, an independent account
  revision, and its immutable canonical genesis hash and bytes;
- `workflow_control_budget_reservations` binds one semantic provider attempt by reservation,
  call, and attempt identity;
- `workflow_control_budget_ledger` is the append-only source for every accepted budget mutation
  revision; a database-commit reconciliation latch is the one deliberate non-ledger run revision;
- `workflow_control_budget_receipts` retains byte-exact request outcomes and response bodies;
- `workflow_control_budget_reconciliations` retains immutable provider-outcome or database-commit
  uncertainty.

The first successful or rejected reserve may create the account only when
`expectedAccountRevision` is zero. Every reserve, rejection, and settlement advances both the
global Workflow run revision and the independent account revision by exactly one. Its ledger entry
is the source for that run revision; a Workflow transition event is neither required nor written.
Ledger, receipt, and any known provider reconciliation commit in the same transaction. Ledger,
receipt, and reconciliation rows are append-only, and the down migration refuses to remove the
namespace while evidence exists.

Ordinary mutations conflict if the run advances past the account revision. With schema 12, a
generation-one reserve can advance an existing, fully settled account across that gap. The service
requires a committed F2 resume transition, a live lease and fence, and the resolved F2 binding for
the exact reserve request. It records the preceding account hash, run revision and hash, and
binding identity in an append-only continuation attached to the reserve ledger entry. The
account identity, limits, counters and historical hashes carry forward. A resumed settlement
requires its own exact F2 binding and a reservation opened under the continued account.
Generation zero retains the original behavior. Older schemas and later generations fail closed
for resumed mutations. The down migration refuses while any continuation is needed for replay.

Every exact durable value uses a Go-owned companion envelope with these closed fields:

- `schema=openslack.workflow_control_budget_durable_record.v1`;
- `authority=workflow-control` and `writer=workflow-control/budget-authority-server`;
- `authorityMode=local-qualification-v1` and `productionAuthority=false`;
- the exact E1 `contractManifestSha256` and trusted-composition `authorityBuildHash`;
- `recordKind` in account, reserve decision, reservation, settlement, ledger entry, receipt, or
  reconciliation;
- `operationalProjection`, containing the byte-stable E1 record without changing its authority;
- `operationalProjectionHash`, the projection's domain hash.

Database exact-byte columns and HTTP record bodies use this outer envelope. Scalar columns must
agree with both envelope metadata and the embedded projection. Cross-spliced build, manifest,
record-kind, projection, or projection-hash combinations fail as integrity errors.

## Mutation and replay order

Every mutation follows one closed order:

1. strictly parse canonical E1 request bytes and derive the fingerprint;
2. acquire ordered advisory locks for the idempotency key and workspace/run;
3. point-read an existing exact receipt;
4. reject an open database-commit reconciliation for the run;
5. lock the GS9-B run head and, for generation one, verify and lock its current F2 binding;
6. lock account and reservation rows in stable order;
7. validate immutable route, running state, resume generation, run/account revisions, policy, and
   limits;
8. transition the reservation and append the ledger entry and any resume continuation;
9. CAS the account and run head;
10. persist an exact companion-envelope receipt and response bytes;
11. commit.

The same idempotency key and fingerprint replays the original response bytes before active
build or policy checks and without adding a ledger row. The same key with a different fingerprint
conflicts. Semantic uniqueness on
reservation, call, and provider attempt prevents a new key from reserving the same provider turn.
A response-loss retry first point-reads the exact receipt. If the original mutation remains absent,
the recovery transaction rereads and locks the exact run head, proves that it still matches the
request, advances it once to `reconciliation_required`, and atomically writes the immutable
database reconciliation and exact receipt. The receipt's accepted revisions remain null because
no budget mutation was accepted; the reconciliation row and latched run revision are the recovery
evidence. Run drift or a second unprovable commit leaves no receipt, reconciliation, or latch.

Provider outcome uncertainty is separate: missing, untrusted, unknown, or overrun usage settles
the ledger to a durable provider reconciliation when the database transaction is known, keeps the
unresolved reservation open, and latches the run in `reconciliation_required`. A
cache hit performs no reserve, settlement, account, ledger, receipt, or reconciliation mutation.
Provider execution may begin only after a durable reserve and a cache entry cannot become visible
until durable settlement in the qualification harness. These orderings are qualification
properties, not production client wiring.

Account recovery starts from the immutable genesis account and folds every accepted, rejected,
settled, and provider-reconciliation ledger kind in revision order. The reconstructed exact bytes
and hash must equal the current account; anchor, chain, or fold drift fails closed. A gap in the run
revision chain must match its immutable continuation and the exact F2 reserve proof. Each rebuilt
provider-attempt ledger entry must also bind the same attempt as its exact provider-usage receipt.
A settled
reservation binds its `closedAt` to its terminal ledger `recordedAt`. Because budget and GS9-B
authority share the run head, an open budget database-commit reconciliation is checked under the
same run advisory lock by both writers and blocks either mutation path. Schema readiness is
validated once at startup: authority schemas 3 through 5 skip this not-yet-present gate, while
schema 6 queries the required table directly and fails if it is absent.

## Service boundary

The image contains `/budget-authority-server`, while its default entry point remains `/server`.
The budget binary is health-only unless exact `local-qualification-v1` mode is configured with a
loopback bind, PostgreSQL, service-build SHA-256, bearer-token SHA-256, one workspace, caller, and
positive routing epoch. Its closed surface contains reserve, settle, account, reservation, receipt,
health, version, and metrics routes only.

The evidence ceiling is exactly:

```text
GS9-E LOCAL_PASS
Go durable budget qualification authority
Go production Workflow budget authority NOT_CLAIMED
Runner v2 NOT_DELIVERED
routing / canary / cutover NOT_ACTIVATED
WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE NOT_DELIVERED
```
