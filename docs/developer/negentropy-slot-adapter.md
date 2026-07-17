# Negentropy-Lab Slot Adapter

`@openslack/integration-negentropy` is a private OpenSlack package that projects
structured OpenSlack evidence into the upstream
`negentropy.slot-contribution.v1` artifact contract. It is not an OpenSlack
plugin, does not run third-party code, and does not share authority with
`PluginHost`.

## Schema pin

The package records an immutable upstream repository, merge commit, schema path,
version, and SHA-256. The exact schema bytes are bundled in source, staged into
the compiled package, and copied into release assets. Runtime export fails
closed if the bytes or `$id` do not match the pin.

The schema contract excludes function-valued lifecycle callbacks from the JSON
artifact and closes objects with `additionalProperties: false`. Its
`scenario-pack.extension` condition requires external/L5/scenario-pack/SHADOW/
opt-in and forbids routes, realtime rooms, `authorityWriterHandle`, and
`proposeMutation`.

## Evidence projection

The adapter calls package APIs rather than parsing terminal output:

- `listWorkflowRuns({ rootDir })`;
- `readEvents(rootDir)`;
- `loadPRReviewPolicy(rootDir)`;
- `buildProfileSyncStatus({ rootDir })`.

Only counts, status distributions, bounded policy booleans, timestamps, and
canonical hashes are exported. Collaboration prose, actor identity, source
references, review text, and credentials are not included.

## Preview artifact

```bash
openslack collaboration integration negentropy export-slot --format json
```

The command emits an `openslack.negentropy.slot-preview.v1` envelope containing:

- the immutable schema pin;
- generation time;
- `readiness: NOT_REGISTERABLE`;
- the unsigned contribution's canonical SHA-256;
- the schema-valid contribution.

The preview is atomically saved to
`.openslack.local/integrations/negentropy/slot-preview.json`. External code must
not treat this preview as a registration request.

## Configuration and external artifacts

Optional configuration:

```yaml
# .openslack/integrations/negentropy.yaml
endpoint: https://negentropy.example/api/authority
keyId: negentropy:production
maxEvidenceAgeHours: 168
```

The endpoint must be HTTPS with no credentials, query, or fragment. Unit tests
may explicitly allow loopback HTTP; the CLI cannot.

External files use these default paths:

```text
.openslack.local/integrations/negentropy/signature.json
.openslack.local/integrations/negentropy/registration-response.json
```

The signature envelope contains only schema ID, canonical artifact hash,
`ed25519`, key ID, and a bounded base64 signature. OpenSlack validates structure
and binding but neither reads nor creates a private key.

## Verification

```bash
openslack collaboration integration negentropy doctor --format plain|json
openslack collaboration integration negentropy status --format plain|json
```

Stable findings cover the schema pin, preview, freshness, signature attachment,
receipt, and live endpoint. A receipt is coherent only if admission completed,
the identities match, and its signed contribution has the same unsigned
canonical hash.

The final live check reads:

```text
GET <endpoint>/slot-contributions
GET <endpoint>/slot-contributions/<contributionId>/diagnostics
```

Requests have a timeout, reject redirects, accept JSON only, and bound declared
and streamed response bytes. No `Authorization` header is added. The live
contribution, diagnostic identity, canonical hash, and lifecycle must all agree
with the receipt.

The state machine is closed to `UNSIGNED_PREVIEW`,
`SIGNATURE_ATTACHED_UNVERIFIED`, and `VERIFIED_BY_NEGENTROPY`. Only the final
state may display the lifecycle returned by Negentropy. The adapter cannot
declare activation or promote the gate.

## Release staging

`bun run schema:stage` copies the exact source schema bytes into the compiled
package. `bun run build`, `typecheck`, and release build all invoke this step so
TypeScript JSON normalization cannot change the pinned byte hash.

See [Negentropy-Lab Slot Boundary](../security/negentropy-slot-boundary.md) for
the non-negotiable authority rules.
