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
  entries. The GS8 worker additionally rejects runtime `import`, re-export, dynamic `import()` and
  `require()` syntax in workflow source, so an accepted source file is the complete executable
  workflow-code closure. This restriction applies only to the default-off GS8 worker; the existing
  CLI loader remains unchanged.
- Protocol stdout contains canonical JSONL only. Diagnostics are bounded and never become workflow
  evidence. Prompts, credentials, transcripts, commands, raw arguments and provider payloads are
  absent from the wire and API.
- A receipt is lifecycle evidence, not confirmation, workflow-effect approval, GitHub review, or
  external effect success.
