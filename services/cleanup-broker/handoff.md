# Cleanup Broker administrator handoff

This is a candidate installation procedure, not installation authorization.
The agent builds and tests in staging only. Never run these commands against
an existing active installation. Do not delete old state to make setup pass.
Use a dedicated Linux/WSL2 host; native Windows Broker support is not claimed.

## Candidate and package checks

The handoff directory contains two independent build reports, `SHA256SUMS`,
Broker and executor artifacts, a runtime dependency inventory, templates and
qualification evidence index. The report records the full candidate commit,
lockfile hash, actual Node/Bun/Go versions, command lines and artifact hashes.
Verify the package against an independently reviewed digest before use:

```sh
cd /absolute/path/to/reviewed-handoff
sha256sum --check SHA256SUMS
```

Only ordinary staging files are included. No private keys, tokens, real
permits, activation records or live ledger are supplied. A runtime inventory
from the build host is discovery evidence, not proof of the target host's
loader, shared-library, CA or NSS dependency closure. Review source packages,
licenses, canonical paths and every dependency on the actual target first.
Do not replace system libraries with build-host copies. Missing/unreviewed
dependencies keep installation BLOCKED; do not shorten the manifest to pass.

## Administrator inputs and responsibilities

| Input                                      | Required evidence                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated Broker UID/GID and Agent UID/GID | Unused IDs before creation; no root, sudo, Docker socket or Broker-group access for Agent; one Agent UID bound to one runtime/run                    |
| Repository                                 | Newly provisioned qualification repository, stable numeric ID, default main, automatic branch deletion off; exact owner/repo and allowed remote name |
| App                                        | Separate least-privilege deletion installation for qualification targets, governance read access kept separate; no token/key in report               |
| Subject                                    | Active governed registry identity, exact principal/runtime/run mapping, scoped action allow, legacy cleanup action deny, adequate risk allowance     |
| Task view                                  | Administrator-attested complete scope, real dependency states and validity period; an empty array is not a discovery shortcut                        |
| Network                                    | Explicit proxy/noProxy and target trust configuration; never inherit Agent settings                                                                  |
| Activation                                 | Reviewed issuer domain, generation and actual startup nonce; main commit contains matching registry/policy/permit bytes                              |
| Exact targets                              | Repository/PR node ID/number, full ref, expected SHA, task ref, allowed action and expiry for each test                                              |

Fill templates offline, preserving their existing schemas. Zero IDs, sentinel
hashes, expired dates and missing targets are intentionally invalid. Templates
must never be installed unchanged. Do not put credential contents in templates.

## Staged administrator installation commands

The following are command recipes for an administrator, not an unattended
installer. Values must come from the approved input record, not Agent guesses.
Each phase stops on error. Verify all fixed targets are absent for a new
installation; on any existing target use the reviewed recovery process instead.
Before identity creation, verify that the target state filesystem is persistent
local Linux storage, not a Windows mount, tmpfs or network filesystem. A partial
provisioning failure must retain its records and stop; do not automatically
delete users, groups, directories or state to undo it.

```sh
set -eu
: "${BROKER_UID:?approved nonzero unused UID}"
: "${BROKER_GID:?approved nonzero unused GID}"
: "${AGENT_UID:?approved different nonzero unused UID}"
: "${AGENT_GID:?approved different nonzero unused GID}"
test "$BROKER_UID" -gt 0
test "$BROKER_GID" -gt 0
test "$AGENT_UID" -gt 0
test "$AGENT_GID" -gt 0
test "$BROKER_UID" != "$AGENT_UID"
test "$BROKER_GID" != "$AGENT_GID"
for target in /etc/openslack-cleanup /usr/lib/openslack-cleanup /run/openslack-cleanup /var/lib/openslack-cleanup; do
  if test -e "$target" || test -L "$target"; then
    echo "Existing installation: stop and use reviewed recovery" >&2
    exit 1
  fi
done
for identity in "$BROKER_UID" "$AGENT_UID" openslack-cleanup-broker openslack-cleanup-agent; do
  if getent passwd "$identity" >/dev/null; then exit 1; fi
done
for identity in "$BROKER_GID" "$AGENT_GID" openslack-cleanup-broker openslack-cleanup-agent; do
  if getent group "$identity" >/dev/null; then exit 1; fi
done
groupadd --gid "$BROKER_GID" openslack-cleanup-broker
groupadd --gid "$AGENT_GID" openslack-cleanup-agent
useradd --uid "$BROKER_UID" --gid "$BROKER_GID" --no-create-home --shell /usr/sbin/nologin openslack-cleanup-broker
useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --no-create-home --shell /usr/sbin/nologin openslack-cleanup-agent
```

Provision the restricted Agent execution mechanism separately. Do not grant
the Agent sudo/runuser merely to run tests; an administrator launches the
already-reviewed agent process under that identity. Do not recycle its UID
while any old process or socket connection remains.

```sh
set -eu
for target in /etc/openslack-cleanup /usr/lib/openslack-cleanup /run/openslack-cleanup /var/lib/openslack-cleanup; do
  if test -e "$target" || test -L "$target"; then
    echo "Existing installation: stop and use reviewed recovery" >&2
    exit 1
  fi
done
install -d -o root -g "$BROKER_GID" -m 0750 /etc/openslack-cleanup
install -d -o root -g "$BROKER_GID" -m 0750 /etc/openslack-cleanup/credentials
install -d -o root -g root -m 0755 /usr/lib/openslack-cleanup
install -d -o root -g root -m 0755 /usr/lib/openslack-cleanup/git-core
install -d -o "$BROKER_UID" -g "$BROKER_GID" -m 0755 /run/openslack-cleanup
install -d -o "$BROKER_UID" -g "$BROKER_GID" -m 0700 /var/lib/openslack-cleanup
```

Install reviewed Broker, Node, Git and shell as root-owned ordinary 0755 files
at `/usr/lib/openslack-cleanup/{cleanup-broker,node,git,sh}`; executor and
installation manifest are ordinary 0644 files there. Materialize the Git
HTTPS helper as a regular single-link 0755 file at
`/usr/lib/openslack-cleanup/git-core/git-remote-https`, not its distribution
symlink/hardlink. Use `install -o root -g root -m MODE SOURCE EXACT_TARGET`
for each approved source/target pair. Verify content hashes after copying.
Canonical shared dependencies must already be administrator-owned and safe;
the manifest lists their real `/usr/lib/` paths, not symlink aliases.

Install the completed `broker.json` and `task-dependencies.json` under
`/etc/openslack-cleanup` as root:BrokerGID 0640. Administrator credential
provisioning supplies fixed `credentials/governance` and
`credentials/github-app-private-key` with the same ownership/mode. Never echo
their contents, pass them on a command line or include them in evidence.
The Agent must not belong to BrokerGID. Configuration and installation hashes
must match exact final bytes, not the placeholder templates.

## Startup, activation and qualification

Launch the Broker in foreground under a reviewed supervisor, or administrator
terminal, with its dedicated primary group and no inherited privileged groups:

```sh
runuser -u openslack-cleanup-broker -- /usr/lib/openslack-cleanup/cleanup-broker
```

Do not activate first. Confirm startup and record the new non-secret instance
metadata from `/var/lib/openslack-cleanup/instance.json` using the administrator
channel. Initial generation can be empty until admission latches the governed
generation. The socket is deliberately 0666 under a Broker-owned 0755 directory;
kernel peer UID authentication controls access. Do not add Agent to the
credential group or loosen state permissions to obtain connectivity.

An administrator separately submits the registry, policy and permits through
the governed configuration workflow into the fixed main source. Policy must
match the actual Broker ID/generation/nonce; each permit binds the exact target,
subject/run, one use, time window and task scope. A restart needs new activation
and permits. This document does not mint a grant or provide an activation API.

The agent then runs the existing CLI with explicit agent/repo/remote/app auth,
permit ID and, for execution/status, original operation ID. Start with preview
and rejection cases, then only registered positive targets. Record separate
results for unmerged, closed-unmerged, protected, open head/base dependencies,
SHA drift, default-denied identity, one successful deletion, repeated-operation
receipt and independent absent-ref preview. Never use OpenSlack production
branches as substitutes. No target is created or deleted by this handoff.

## Evidence, stop and recovery

For each case retain candidate and artifact hashes, OS/version and authenticated
subject, target tuple, timestamp, command/exit, operation ID, permit state,
attempted, intent/outcome link and observed ref. Claim remains `not_required` /
`not_evaluated`. Redact credentials and unrelated repository data.

On unknown result stop destructive operations and query the original operation.
Do not reissue a permit to retry it. Preserve the ledger and worker journal
together, even after a crash or restore. An absent ref alone is not proof that
this operation deleted it.

To stop, signal the exact supervised Broker process with SIGTERM, allowing its
bounded worker shutdown and durable receipt handling. Do not use `pkill` by
name, kill a reused PID or delete a stuck lock. A recovery-poisoned Broker may
retain the lock intentionally; the administrator must establish old group
absence before restart. Never reset state, copy an active installation, perform
automatic failover or silently fall back to human/direct deletion.

Completion remains layered: artifact/regression PASS is not installed isolation,
real GitHub qualification, human approval, PRMS merge or release readiness.
