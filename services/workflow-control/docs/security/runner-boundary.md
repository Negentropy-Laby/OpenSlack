# GS8-B Runner Security Boundary

- The runner API binds one configured workspace and requires a bearer token whose stored form is a
  SHA-256 digest. It accepts canonical hash-only job specifications and bound cancellation data.
- The worker bundle manifest is externally SHA-256 anchored. Its closed root contains exactly the
  manifest, one copied Node executable and one self-contained JavaScript entrypoint. The
  `runnerBuildHash` is recomputed from the entrypoint bytes; extra files, directories, links,
  reparse points or byte drift fail closed. Argv, environment and working directory are fixed
  before any job is read, and launch never uses a shell.
- Linux uses a parent-death signal and process group; Windows uses a Job Object. Other operating
  systems fail closed at the runner-server entry point.
- The descriptor store is owner-only. POSIX requires owner UID plus `0700/0600` and no-follow
  opens. Windows requires a protected ACL limited to the current SID and SYSTEM and rejects
  reparse points.
- Workflow source is bounded, canonical-path checked and hash verified before lease acceptance,
  immediately before import and immediately after import. The full source hash separates ESM cache
  entries. The GS8 worker additionally rejects runtime `import`, re-export, dynamic `import()`,
  `require()`, and direct Node `process`/global module-loader references in workflow source. This
  dependency-closure check supplements the reviewed, hash-bound source and sealed process
  environment; it is not an independent JavaScript sandbox. The restriction applies only to the
  default-off GS8 worker; the existing CLI loader remains unchanged.
- Protocol stdout contains canonical JSONL only. Diagnostics are bounded and never become workflow
  evidence. Prompts, credentials, transcripts, commands, raw arguments and provider payloads are
  absent from the wire and API.
- A receipt is lifecycle evidence, not confirmation, workflow-effect approval, GitHub review, or
  external effect success.

GS9-F2b keeps its runtime-delivery credentials outside the bundle. The host verifies the raw
loopback companion token against the configured SHA-256 value, reserves every runtime and budget
environment name against manifest override, and injects them only into a v2 worker when both v2
qualification and runtime delivery are explicitly enabled. The journal is an owner-local child of
the workspace `.openslack.local` root. A v1 worker, F1-only v2 worker, default `/server` image, or
manifest-provided environment cannot acquire these bindings.

Authority is split deliberately: TypeScript remains source authority for checkpoint, effect,
resume, and workflow execution; the isolated E2 store remains budget qualification authority; Go
coordinates exact binding/order/ACK evidence. Neither a stage receipt, event receipt, observer
receipt, nor an unacknowledged decision can be promoted into another plane's authority. Unknown
outcomes preserve reconciliation and source claims rather than enabling retry with a new identity.
