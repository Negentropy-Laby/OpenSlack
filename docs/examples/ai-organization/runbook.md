---
schema: openslack.document.v1
id: example-ai-organization-runbook
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# AI organization demo runbook

## Prerequisites

- Run commands from the OpenSlack repository root.
- Use Node.js 22+ and Bun.
- Treat `examples/ai-organization-demo/recorded-run/` as sanitized fixture evidence.
- Do not add the live flags until the separately reviewed six-agent registry is present.

## 1. Validate the workflow contract

```bash
bun run openslack collaboration workflow validate ai-org-transformation
bun run openslack collaboration workflow list
bun run openslack collaboration workflow preview-js ai-org-transformation
bun run openslack collaboration workflow dry-run ai-org-transformation
bunx vitest run --project @openslack/workflows \
  packages/workflows/src/__tests__/ai-org-transformation-project.test.ts \
  packages/workflows/src/__tests__/ai-org-demo-rehearsal.test.ts
```

The list output must include `ai-org-transformation`. The tests load the six checked-in agent
fixtures, enforce the Runtime schemas, assert concurrency never exceeds two, verify the exact seven
filenames, and validate the input/result/recorded-run/projection JSON schemas. Preview is static and
must report zero agent calls. Dry-run uses a schema-compatible deterministic result, launches no
agent, performs no network request or external write, and exits non-zero if its `errors` array is
non-empty.

## 2. Rehearse with the offline fixture

Bash or WSL:

```bash
./scripts/demo-ai-org-rehearse.sh \
  --mode fixture \
  --out .openslack.local/demo/ai-org-fixture
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo-ai-org-rehearse.ps1 `
  --mode fixture `
  --out .openslack.local\demo\ai-org-fixture
```

The output directory must be absent or empty. Fixture mode rejects `--repo` and `--execute`, imports
no GitHub or Workflow package, launches no subprocess, and performs no network request. It copies:

```text
artifacts/<seven Markdown files>
manifest.json
projection.json
rehearsal-result.json
```

Successful fixture output reports `evidenceLevel: LOCAL_PASS`.

## 3. Optional live GitHub rehearsal

Live mode is an external qualification, not a hidden prerequisite for merging QW0 core. Run it only
against the explicitly named rehearsal repository:

```bash
./scripts/demo-ai-org-rehearse.sh \
  --mode live \
  --repo owner/repository \
  --execute \
  --out .openslack.local/demo/ai-org-live
```

The command fails closed before mutations unless all of these are true:

1. `--repo owner/name`, `--execute`, and an empty `--out` directory are explicit.
2. All six separately reviewed agent registry entries exist.
3. The explicit repository matches the HTTPS `origin` target, uses canonical `main`, and local
   `main` equals the GitHub App-observed current remote `main` SHA.
4. GitHub authentication resolves to the configured App installation bot identity.
5. The repository already has `openslack:task` and `openslack:ready` labels.
6. The configured Agent Runtime completes the structured workflow with exactly seven artifacts.

Only then does the script create an isolated `demo/ai-org-*` worktree and branch, one parent and
seven child Issues, and a draft PR through `bot-gh-pr-create`. It never invokes raw
`gh pr create`, never pushes to `main`, never approves or merges, and never reads credential files.
Before Markdown synthesis and again before branch materialization, closed schemas and bounded
recursive scans reject unexpected fields, oversized values, and credential-like Bearer, Basic,
API-key, authorization, or cookie material.

Successful live output reports `evidenceLevel: GITHUB_REHEARSED` and records only repository name,
public object numbers, workflow run ID, branch, commit ID, and artifact filenames. It does not store
credentials, environment values, prompts, or transcripts.

## Failure semantics

The script returns a JSON object with `status: blocked` and a stable code for expected unmet gates.
It never converts missing agent/provider/GitHub configuration into fixture completion. A partial
external failure may leave already-created Issues or a branch; inspect the named repository and
handle them through normal GitHub governance rather than silently deleting evidence.
