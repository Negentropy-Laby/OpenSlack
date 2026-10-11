# Cleanup administrator toolkit

This independently versioned toolkit accompanies the unchanged v1/v2 cleanup
handoff profiles. It collects facts, converts evidence, prepares qualification
fixtures, verifies an offline backup, checks isolation and inspects an actual
instance. It does not approve deployment, install credentials, activate a Broker,
issue a Permit or delete a branch. A valid toolkit proves its bytes and candidate
binding; it does not prove that a target is installed or authorized.

Use the separately published candidate SHA and SHA-256 of `SHA256SUMS` to verify
the toolkit. Do not obtain the expected values from the copy being checked. Run
from the extracted toolkit directory on a Linux filesystem:

```sh
node ./verify-toolkit.mjs --package "$PWD" --candidate "$cleanup_candidate" --manifest-sha256 "$cleanup_manifest_sha256"
```

The operator must first set `cleanup_candidate` and `cleanup_manifest_sha256` to
the externally published values for this exact release. Exit 0 means that the
fixed file collection and both build proofs match; exit 2 means stop and preserve
the directory. An unsupported safe-read platform also exits 2. The verifier does
not need the development checkout or a GitHub credential.

Python tools require Linux, `/proc`, Python 3 and the adjacent `_safety.py` and
`target-observation.py` files shipped in the verified collection. Invoke Python
with `-I -B` to exclude caller import paths and avoid local bytecode writes. The
Node bundles require a supported Node runtime; qualification builds use actual
Linux Node 24.18.1, Bun 1.4.0 and Go 1.26.5. Bun is the build pin even though the
root package contains a historical pnpm `packageManager` declaration.

## Actual target observation

Only an administrator may execute these commands on the approved target. Create
a new private output directory outside all installation/configuration/state
paths; do not reuse an old evidence directory. After that separate authorization:

```sh
umask 077
mkdir -m 0700 /root/openslack-cleanup-evidence-new
python3 -I -B ./target-observation.py --output /root/openslack-cleanup-evidence-new/target-observation.json --window-hours 24
python3 -I -B ./dependency-inventory.py --observation /root/openslack-cleanup-evidence-new/target-observation.json --raw-output /root/openslack-cleanup-evidence-new/dependency-observation.json --inventory-output /root/openslack-cleanup-evidence-new/dependency-inventory.json --window-hours 24
```

An existing output is refused. Missing objects remain missing; a manifest is a
historical claim, not proof of the current installation. The observation records
actual file identities, modes, ownership, identities, process/state facts and
errors. The dependency collector accepts only trusted fixed installed programs
whose bytes still match the observation. Its scope is the ELF load-time dependency
closure; it does not establish `dlopen`, NSS, plugins or all runtime behaviour.
Any unsupported object, source change, unknown dependency or collection failure
stops the dependent evidence stage. Credential contents are never collected.

## Production evidence drafts

`prepare-evidence.mjs --input <absolute-recipe.json>` is an offline conversion
entry. Recipes use `openslack.cleanup_admin_evidence_input.v1`. The target phase
names the selected non-secret bindings, actual target/dependency observations,
App scope, network attestation and complete task view with their expected source
digests. Every supplied source is re-read safely and checked against its actual
bytes. Missing administrator decisions are reported separately. Missing, invalid
or expired required sources produce no formal evidence collection.

```sh
node ./prepare-evidence.mjs --input /root/openslack-cleanup-inputs/target-recipe.json
```

The package phase consumes the published target draft, a verified handoff directory
and its externally expected `SHA256SUMS` digest. It revalidates original sources
and outputs DRAFT upgrade inputs and a current host report, never an approval:

```sh
node ./prepare-evidence.mjs --input /root/openslack-cleanup-inputs/package-recipe.json
```

The output names, actual digests, earliest source expiry, `blockingIssues` and
`missingAdministratorDecisions` are included in the result. A non-zero result or
reported blocking issue stops the relevant preparation phase. Output directories
are exclusive. Do not relabel a rehearsal as formal evidence, extend a source
window or copy `APPROVED`, `complete` or `administratorConfirmed` from an old
record. The package `SHA256SUMS` digest and the Broker installation-manifest
digest describe different byte collections.

## Independent qualification fixtures

The fixture tool uses the existing human `gh` login and independently verifies
the selected operator `wsman` (21962212), private qualification repository
`Negentropy-Laby/openslack-cleanup-qualification` (1380965476), `main`, push
permission and disabled automatic branch deletion. It is never run by the
qualification Agent. No bot/PAT environment fallback, approval review, ruleset
bypass or branch deletion is provided.

```sh
node ./qualification-fixtures.mjs plan --scratch-root /root/openslack-cleanup-fixtures-new
node ./qualification-fixtures.mjs inspect --batch "$cleanup_fixture_batch"
```

Set `cleanup_fixture_batch` only to the actual `batchDirectory` printed by the
read-only plan. Planning reads GitHub and writes only a new local batch. Each
following command needs a separate authorization and an exact interactive
confirmation of the displayed batch, repository, plan or observed PR:

```sh
node ./qualification-fixtures.mjs create --batch "$cleanup_fixture_batch"
node ./qualification-fixtures.mjs close-case --batch "$cleanup_fixture_batch"
node ./qualification-fixtures.mjs merge-targets --batch "$cleanup_fixture_batch"
```

The ordinary GitHub merge still requires applicable human approval and checks.
Each merge is independently confirmed. `advance-drift --batch ... --permit-id ...
--approved-sha ...` and `register-existing-fork --batch ...` are later, separately
authorized phases, not automatic follow-ups. Unknown mutations preserve a fsynced
intent and stop; use `inspect`, never replay `create` or retry an uncertain result.
Collect the final complete task view only after all fixture changes. Windows
fixture records state file-only fsync explicitly; no directory-fsync guarantee is
invented on that platform.

## Offline backup and recovery verification

This entry is restricted to the approved route: artifacts already installed,
Broker never started and ledger/journal/instance absent. It is not a running
Broker backup tool. From the verified toolkit directory and after deployment
scope approval, with an existing private parent directory:

```sh
python3 -I -B ./offline-backup.py --backup /root/openslack-cleanup-backups/new-offline-backup
```

The fixed allowlist contains non-secret ordinary installed artifacts and optional
non-secret configuration/manifest files. There is no recursive credential or
state-directory archive. The backup records original byte digests, UID/GID,
modes and explicit absences, synchronizes files and directories and checks the
restorable copies inside its own new directory. Unexpected history, a running
process, source replacement, partial writes, sync failure or recovery mismatch
stops the offline route. Preserve partial output and reconcile; do not clear
state, recycle identities or rerun over the directory. Actual restoration remains
a separately reviewed administrator operation.

## Isolation before and after startup

```sh
python3 -I -B ./isolation.py --phase pre-start --output /root/openslack-cleanup-evidence-new/isolation-pre-start.json
python3 -I -B ./isolation.py --phase post-start --output /root/openslack-cleanup-evidence-new/isolation-post-start.json
```

Run the second command only after an independently authorized startup. Pre-start
acceptance checks existing installation/configuration and OS identities; runtime
objects that do not exist yet are pending. This Python result does not establish
the local runtime identity, registry or private workspace. Check those separately
as the actual selected Agent OS user, using the selected non-secret input file
and its externally confirmed digest:

```sh
node ./verify-workspace.mjs --workspace "$cleanup_private_workspace" --selected-bindings "$cleanup_selected_bindings" --selected-bindings-sha256 "$cleanup_selected_bindings_sha256"
```

These variables identify the administrator-prepared dedicated workspace and
selected input record; do not substitute the development checkout. Missing or
different principal, runtime UID, fixed run, registry bytes, permissions or private
paths must return BLOCKED. This entry safely captures non-secret bytes and invokes
the production parsers and permission checks. It does not bootstrap an identity,
publish a record or create an execution context. Both independent pre-start
results are required. Post-start requires
the actual ledger, journal, instance, socket and runtime directory. Absence is
not a vacuous PASS. Real Agent UID/group access checks, supplementary groups and
potential privilege paths must be accounted for; unknown privilege remains
BLOCKED. Credentials are checked through metadata/access only, without opening
their contents or hashing them.

## Supervised startup and real nonce

Startup is a separate administrator action after installation and pre-start
isolation acceptance. Verify the actual approved Broker account/UID/GID first.
`/run/openslack-cleanup` must already be Broker-owned 0755; persistent state stays 0700. Do not recreate accounts or remove existing lock/ledger/journal files.

The reviewed foreground command, in a dedicated administrator terminal, is:

```sh
runuser -u openslack-cleanup-broker -- /usr/lib/openslack-cleanup/cleanup-broker
```

It accepts no configuration overrides. Do not guess a systemd service. First
startup is deliberately unactivated and produces the actual instance before
governance activation is prepared. Use a separately observed actual PID and the
approved installed Broker digest, then inspect from another administrator
terminal:

```sh
python3 -I -B ./inspect-instance.py --pid "$cleanup_actual_broker_pid" --expected-broker-sha256 "$cleanup_installed_broker_sha256" --output /root/openslack-cleanup-evidence-new/instance-observation.json
```

The default rejects an already activated instance; `--allow-activated` is only
for an explicitly selected later inspection phase. The nonce is bound to the
observed PID, executable bytes, OS identity and safely read instance. Old,
unknown or changing instances are refused. This entry does not start or activate
anything. No invented nonce is accepted as startup evidence.

## Stage boundaries and source review

The sequence is refreshed evidence, formal package verification, new input
approval, verified backup/offline upgrade, pre-start isolation, unactivated
startup, post-start isolation/nonce, governed activation/Permit and the full
qualification matrix. Task-view changes require controlled shutdown, a new boot,
activation and Permit; evidence expiry, target changes, proxy-owner changes or
restart stop the affected batch. An unknown cleanup result is queried by its
original operation, never retried with a new Permit.

The imported host/dependency implementations originate from the reviewed frozen
collectors, not the old path-based collector or the evidence builder that inferred
installed facts. Platform checks, shared safety code and regressions are reviewed
repository changes. Rehearsals and prior approvals are not included in this toolkit.
The QA ledger retains source digests and separates component tests, package
integrity, actual installation and real GitHub qualification.
