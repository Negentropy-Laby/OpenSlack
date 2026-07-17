# Prepare an OpenSlack contribution for Negentropy-Lab

OpenSlack prepares an external `scenario-pack.extension` preview. It does not
sign or register the contribution and never owns Negentropy-Lab
`AuthorityState`.

## 1. Export the unsigned preview

From an initialized OpenSlack workspace:

```bash
openslack collaboration integration negentropy export-slot --format json
```

The command writes
`.openslack.local/integrations/negentropy/slot-preview.json`. Confirm that it
reports:

```text
readiness: NOT_REGISTERABLE
providerKind: external
layer: L5
kind: scenario-pack
gate.mode: SHADOW
gate.activationMode: opt-in
metadata.projectionOnly: true
```

The manifest must have no routes, realtime rooms, lifecycle callbacks, writer
handle, or mutation route.

## 2. Run the local doctor

```bash
openslack collaboration integration negentropy doctor --format plain
```

Before external signing, the expected top-level state is
`UNSIGNED_PREVIEW`. Schema, preview, and freshness findings can pass while
signature, receipt, and endpoint findings remain skipped.

## 3. External signing and registration

A trusted party outside OpenSlack signs the preview's canonical contribution
hash and supplies a signature envelope. A Negentropy administrator registers
the signed contribution through its governed process and supplies the complete
registration response.

Place those externally produced artifacts at:

```text
.openslack.local/integrations/negentropy/signature.json
.openslack.local/integrations/negentropy/registration-response.json
```

OpenSlack does not request the signing private key or Negentropy write
credentials. Do not pass either to the CLI.

## 4. Configure read-only verification

Create:

```yaml
# .openslack/integrations/negentropy.yaml
endpoint: https://negentropy.example/api/authority
keyId: negentropy:production
maxEvidenceAgeHours: 168
```

The endpoint must expose the contribution list and per-contribution diagnostics
to the current environment without embedding credentials in the URL. The bridge
makes GET requests only and never adds an authorization header.

## 5. Verify Negentropy agreement

```bash
openslack collaboration integration negentropy doctor --format plain
openslack collaboration integration negentropy status --format json
```

`SIGNATURE_ATTACHED_UNVERIFIED` means a signature exists but no trusted live
agreement has been proven. `VERIFIED_BY_NEGENTROPY` requires all of:

- a structurally bound signature envelope with the configured key ID;
- a completed admission receipt with non-empty receipt ID;
- matching contribution, slot, provider, and diagnostics identity;
- the same unsigned canonical contribution hash;
- a live HTTPS contribution and diagnostics response matching the receipt;
- fresh OpenSlack evidence.

Only Negentropy's live diagnostics supply the displayed lifecycle. OpenSlack
does not infer or claim activation and never changes the contribution from
SHADOW to ENFORCE.

## Rollback

Remove or archive the local preview/signature/registration-response files and
stop invoking export. OpenSlack continues as a standalone workbench. Any
deactivation or removal in Negentropy is performed by its administrator through
Negentropy's own governed process.

See also:

- [`../product/negentropy-lab-integration.md`](../product/negentropy-lab-integration.md)
- [`../developer/negentropy-slot-adapter.md`](../developer/negentropy-slot-adapter.md)
- [`../security/negentropy-slot-boundary.md`](../security/negentropy-slot-boundary.md)
