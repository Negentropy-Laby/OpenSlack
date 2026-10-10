# Cleanup Broker-only client

`tools/cleanup-client.mjs` is the client that ships inside the artifact package.
It is **Broker-only**: every cleanup request goes to the cleanup broker, which
authenticates its operating-system peer and the durable request binding.

## What it does

```text
client.mjs --mode preview --workspace <dedicated-workspace> --agent-id <id> --principal-id <id> --runtime-uid <uid> \
  --run-id <id> --repo <owner/name> --remote <name> --pr <number> --permit-id <id>
client.mjs --mode execute ... --operation-id <id>
client.mjs --mode status  ... --operation-id <id>
client.mjs --mode status  --operation-record <path>
```

- `preview` asks the broker what it would do. It never deletes and prohibits
  `--operation-id`.
- `execute` asks the broker to perform one governed deletion for one operation
  ID. The broker remains the only component that deletes anything.
- `status` re-reads one operation. It never retries a deletion.

## What it deliberately does not do

- **No direct-deletion fallback.** The client does not import the repository's
  branch-cleanup path, does not shell out to Git, and exposes no option that
  deletes a remote branch without the broker. A test in the PR package asserts
  this against the client source, so it cannot regress silently.
- **No authorization.** The identity fields it sends are claims. The broker
  binds them to administrator-controlled authority independently; a client that
  presents a claim the broker does not recognise is refused there.
- **No result fabrication.** The client prints the broker's response verbatim
  and, for an unresolved operation, tells you to query status rather than repeat
  execute.

## Workspace and platform boundary

Preview, execute and identity-based status require an explicit `--workspace`.
The administrator must install the fixed runtime identity and registry there;
missing identity is refused, never bootstrapped with a new run ID. Explicit
principal, runtime UID and run fields only cross-check that local identity.
Record-based status requires neither a workspace nor a surviving registry or
identity, and queries the original operation without admitting another execute.

Record publication and reads require Linux descriptor anchoring and `/proc/self/fd`.
Windows and macOS refuse them with `UNSUPPORTED_PLATFORM` before publication;
there is no pathname-only fallback. Directory movement refuses sending even if
writes already occurred within the original authorized directory. Unknown results
must be queried using the original operation rather than a newly issued Permit.

## Operation records

`--mode status --operation-record <path>` reads a record the client published
before an earlier `execute`. The record holds the versioned schema, the creation
time, the original execute request and its production digest — no credentials.

A record is **evidence, not authorization**. It is readable only in `status`
mode, it cannot admit a preview or execute, and it carries no result. Records
are written to `.openslack/outbox/cleanup-operations/` and that subdirectory is
gitignored; configure the same ignore rule in the target workspace.

## The offline verifier makes no claims either

`tools/verify-handoff.mjs` checks a package against a candidate commit and a
manifest digest that you supply from independent evidence. A passing run means
the package bytes match those bindings. It does **not** mean the package is
installed, deployed, approved or authorized to execute, and it never reports
that any of those steps are complete. A fresh intact package exits 0 while
listing outstanding approval, deployment, activation and Permit gates. Corrupt
bytes, expired evidence or unknown gates exit 2; `validityIssues` explains the
failure independently of `outstandingGates`. `unmetGates` retains both lists for
older consumers.
