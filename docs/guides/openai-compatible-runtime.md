---
schema: openslack.guide.v1
status: active
created: 2026-07-11
---

# OpenAI-compatible Agent Runtime

OpenSlack includes one production in-process agent provider using the OpenAI
Chat Completions tool-call protocol. It does not require an Aby or
Negentropy-Lab checkout. The model endpoint remains an external dependency.

## 1. Preview non-secret configuration

Choose an `env:` or `keychain:` credential reference. Do not pass the credential
value on the command line or place it in project configuration.

```bash
bun run openslack agent-runtime setup openai-compatible \
  --base-url https://provider.example/v1 \
  --model example-model \
  --credential-ref env:OPENSLACK_LLM_API_KEY
```

The command is preview-only unless `--write` is present. Review the preview,
then save it:

```bash
bun run openslack agent-runtime setup openai-compatible \
  --base-url https://provider.example/v1 \
  --model example-model \
  --credential-ref env:OPENSLACK_LLM_API_KEY \
  --write
```

The resulting `.openslack.local/agent-runtime.json` stores only the URL, model,
credential reference, timeout, and safety limits. It is local and gitignored.

## 2. Supply the credential at runtime

For an `env:` reference, set the named environment variable in the
operator-owned process environment. For a native keychain reference, preview a
source-file import before applying it:

```bash
bun run openslack agent-runtime credential import \
  --source /operator-owned/path/provider-key.txt \
  --credential-ref keychain:openslack/openai-compatible

bun run openslack agent-runtime credential import \
  --source /operator-owned/path/provider-key.txt \
  --credential-ref keychain:openslack/openai-compatible \
  --write
```

Add `--delete-source` only when you want OpenSlack to attempt source cleanup
after a successful keychain write. Deletion is best-effort; a failure produces
an explicit manual-cleanup warning and does not claim that the source was
removed. The preview reads neither the source file nor the keychain.

Then use the same reference in setup:

```bash
bun run openslack agent-runtime setup openai-compatible \
  --base-url https://provider.example/v1 \
  --model example-model \
  --credential-ref keychain:openslack/openai-compatible \
  --write
```

OpenSlack resolves either reference only at the HTTP transport boundary; the
value is not copied into run metadata, transcripts, configuration previews,
logs, or diagnostics.

## 3. Select the provider for an agent

Execution provider and model vendor are separate fields. An agent registry entry
selects the runtime explicitly:

```yaml
schema: openslack.agent_registry.v1
agent_id: repository_worker
vendor:
  runtime_provider: openai-compatible
  provider: your-model-vendor
  model: example-model
permission_mode: default
isolation: worktree
```

Without `runtime_provider: openai-compatible`, that agent remains fail-closed
with `RUNTIME_NOT_CONFIGURED`; setup does not silently rewrite agent identities.

## 4. Diagnose and smoke-test

```bash
bun run openslack agent-runtime doctor --provider openai-compatible
bun run openslack agent-runtime doctor --provider openai-compatible --format json
bun run openslack agent-runtime smoke --provider openai-compatible
```

Doctor reports `not_configured`, `misconfigured`, `unavailable`, or `ready` and
never prints the resolved credential. Smoke performs one read-only model call and
persists terminal run evidence under `.openslack.local/agents/runs/`.

## Tool and budget boundary

The provider can see only tools allowed by the agent permission profile:

- `repo.read`
- `repo.search`
- `repo.apply_patch`
- `repo.diff`

There is no unrestricted shell tool. All paths remain inside the selected
workspace or disposable worktree. Credential-equivalent paths, `.git/**`,
`.openslack.local/**`, and Black Zone paths are inaccessible. `plan` and
`strict` modes are read-only; provider-driven Red Zone writes are rejected in
every mode and must follow the separate human-governed change path. Tool
execution shares the run cancellation/deadline boundary, and results are bounded
and redacted before both provider reuse and transcript persistence.

Provider-reported token usage is mandatory and charged after every response.
Token budget exhaustion uses `BUDGET_EXCEEDED`; turn, tool-call, response-byte,
tool-result-byte, and wall-clock limits remain separate terminal evidence.
