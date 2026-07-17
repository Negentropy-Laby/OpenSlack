# Live Capstone Harness

The live capstone harness records the minimum non-secret evidence needed to
evaluate OpenSlack on Windows x64 and Linux x64. It does not perform privileged
GitHub, npm, signing, model-provider, or Negentropy administrator operations.
Those remain operator actions outside the harness.

## Tested-commit rule

Run the capstone only after the LIVE-1 product commit has merged. Use that full
40-character merge SHA for every `plan`, `record`, and `verify` call on both
platforms. A run cannot change its tested commit. If product code changes, start
a new correlation ID and repeat both platforms.

Local state is written only to:

```text
.openslack.local/capstone/<correlation-id>/run.json
```

The manifest contains correlation ID, tested commit, OS/architecture, timestamps,
step results, SHA-256 artifact hashes, and bounded redacted evidence references.
It does not persist credential references, filesystem paths, tokens, endpoint
secrets, PEM contents, private keys, or response bodies.

## Commands

Create a run:

```bash
bun run live:capstone -- plan \
  --tested-commit <40-character-merge-sha> \
  --correlation-id CAP-YYYYMMDD-XXXXXXXX \
  --credential-ref keychain:openslack/capstone-provider \
  --signed-artifact <signed-release-manifest> \
  --public-key <trusted-public-key>
```

The credential argument must be an opaque `credential:` or `keychain:`
reference. The harness validates only that the two artifact paths are regular
files; it does not persist their paths. A signed artifact is never accepted from
a credential-like `.pem`, `.key`, `.p12`, or `.pfx` path.

Record one result:

```bash
bun run live:capstone -- record \
  --correlation-id CAP-YYYYMMDD-XXXXXXXX \
  --tested-commit <40-character-merge-sha> \
  --platform windows-x64 \
  --step release_artifacts \
  --status PASS \
  --evidence-ref artifact:release/windows-x64 \
  --artifact <artifact-to-hash>
```

Repeat with `--platform linux-x64`. `--evidence-ref` and `--artifact` may be
repeated. Evidence references must use one of the non-secret prefixes
`artifact:`, `github:`, `negentropy:`, `npm:`, `openslack:`, or `run:`.

Verify the complete run:

```bash
bun run live:capstone -- verify \
  --correlation-id CAP-YYYYMMDD-XXXXXXXX \
  --tested-commit <40-character-merge-sha>
```

Verification fails unless both platforms have all 11 `PASS` results, every
result is no more than 30 days old, the tested commit is identical, and the run
manifest passes the secret canary.

## Required steps

Record these exact step IDs:

1. `release_artifacts` — v0.2.0 archive, SBOM, provenance, signature, and public-key verification.
2. `clean_machine_archive` — clean Windows/Linux archive launch and verification.
3. `guided_attach` — transactional attach in an ordinary test repository.
4. `github_app_readiness` — accepted permissions, events, and repository scope.
5. `openai_compatible_provider` — configured credential reference and provider doctor.
6. `issue_claim_agent_delivery` — Issue, claim, agent execution, and bot draft PR.
7. `repository_webhooks` — real PR, review, and check observations.
8. `pr_doctor` — PRMS diagnosis on the capstone PR.
9. `independent_human_approval` — current-head approval from a non-author human.
10. `merge_steward_issue_done` — governed merge and completed Issue lifecycle.
11. `negentropy_preview_schema` — unsigned preview and pinned-schema parity.

## External execution boundaries

- A GitHub App owner accepts new permissions and event subscriptions.
- npm maintainers bootstrap the four packages, configure the stage-only trusted
  publisher, and complete the required 2FA review.
- A trusted external party signs the Negentropy contribution and a Negentropy
  administrator registers it.
- An independent human approves the capstone PR.
- The harness never receives raw tokens, App private keys, signing private keys,
  endpoint secrets, or npm bootstrap credentials.

LIVE-2 evidence may be generated only from a valid dual-platform verification
on the tested merge commit. Missing evidence retains its blocker; it must not be
reported as production-ready.
