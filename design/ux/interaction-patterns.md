# Product Interaction Patterns

## Submit and Forget

Caller sends one versioned request with Bearer key and `Idempotency-Key`. `202` means durable acceptance, not vendor
delivery. Retrying the same request is safe; changing bytes under the same key is a visible 409 error.

## Asynchronous Status

Business submission does not synchronously wait for the vendor. Authorized operators query summary/detail/history;
responses expose stable states and sanitized diagnostics, not payload, credential, lease or actor internals.

## Preview Then Execute

Replay preview is read-only and returns per-item eligibility/version. Execute is a new authenticated request with
explicit IDs and expected versions. State drift produces per-item skip rather than overwriting current state.

## Partial Batch Result

Replay execute is best-effort. Every input index appears exactly once in `succeeded`, `skipped` or `failed`, each
ordered by input index. A top-level success status never hides per-item failure.

## Enumeration-Safe Errors

Missing, out-of-scope and protected lifecycle states share the same public negative result where specified. Detailed
state is returned only after authorization proves the resource is in scope.

## Outcome Unknown

When commit/result is unknown, clients query by stable identity/version or repeat the idempotent command. They never
guess success, create a new key automatically or blindly replay.

## No UI Substitution

The API and runbook are the MVP interaction contract. A future CLI or admin UI must call the same OpenAPI and Store
contracts; it cannot add privileged bypass operations.

