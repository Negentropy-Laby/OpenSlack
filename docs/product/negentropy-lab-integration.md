# OpenSlack × Negentropy-Lab Integration

OpenSlack remains a standalone GitHub-native collaboration workbench.
Negentropy-Lab remains the control plane and sole owner of `AuthorityState`.
The implemented integration is a one-way, projection-only preview and
verification bridge for the upstream `scenario-pack.extension` slot.

## Product boundary

OpenSlack's operational loop remains:

```text
Issue → Agent → PR → Doctor → Human Approval → Merge Steward → Done
```

The bridge exports bounded facts derived through package APIs from workflow
runs, PRMS policy/events, profile-sync status, and collaboration events. It does
not parse CLI prose, export event summaries or actor handles, or mutate
Negentropy-Lab.

The contribution is fixed to:

| Property | Value |
|----------|-------|
| slot | `scenario-pack.extension` |
| provider | `external` / `openslack` |
| layer and kind | `L5` / `scenario-pack` |
| gate | `SHADOW` |
| activation mode | `opt-in` |
| data path | projection-only |
| preview readiness | `NOT_REGISTERABLE` |

It has no route, realtime room, lifecycle callback, writer handle, or mutation
method. Its forbidden methods include `authorityWriterHandle` and
`proposeMutation`.

## Commands

```bash
openslack collaboration integration negentropy export-slot --format json
openslack collaboration integration negentropy doctor --format plain
openslack collaboration integration negentropy status --format json
```

`export-slot` validates an exact, SHA-256-pinned upstream JSON Schema and writes
an unsigned canonical preview to
`.openslack.local/integrations/negentropy/slot-preview.json`.

`doctor` validates:

- the bundled upstream schema hash;
- preview canonical hash and freshness;
- an externally supplied signature envelope's structure, key ID, and artifact
  binding;
- a completed upstream registration receipt;
- agreement with the live HTTPS contribution and diagnostics endpoints.

OpenSlack does not cryptographically verify the signature itself, read a signing
private key, sign the contribution, or register it.

## State model

The top-level status is intentionally closed:

1. `UNSIGNED_PREVIEW`
2. `SIGNATURE_ATTACHED_UNVERIFIED`
3. `VERIFIED_BY_NEGENTROPY`

A local receipt cannot create the third state. It requires a completed admission
receipt whose contribution and diagnostic identities match, followed by live
HTTPS reads that return the same unsigned canonical contribution and lifecycle.
Only then may OpenSlack display the lifecycle value returned by Negentropy.
OpenSlack never independently reports registration, validation, installation,
or activation.

## External responsibilities

An external trusted party signs the canonical contribution. A Negentropy
administrator registers it and supplies the registration response. Endpoint
configuration is stored in `.openslack/integrations/negentropy.yaml`; the
signature envelope and registration response are stored under the gitignored
`.openslack.local/integrations/negentropy/` directory.

These actions do not authorize OpenSlack to call write routes. Version 1 never
changes `gate.mode` to `ENFORCE` and never touches `AuthorityState`.

## Related documentation

- [`../developer/negentropy-slot-adapter.md`](../developer/negentropy-slot-adapter.md)
- [`../security/negentropy-slot-boundary.md`](../security/negentropy-slot-boundary.md)
- [`../guides/embed-openslack-in-negentropy-lab.md`](../guides/embed-openslack-in-negentropy-lab.md)
- [`collaboration-layer.md`](collaboration-layer.md)
