# Self-Evolution Guardrails

## Zone Classification

| Zone       | Paths                                                                                                                                                                                                                             | Auto-Merge                    | Human Required |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------- |
| **Green**  | `docs/**`, `templates/**`, `.openslack/tasks/**`, `.openslack/audit/**`, `.openslack/self/scorecards/**`, `.openslack/self/experiments/**`                                                                                        | Yes, after checks             | No             |
| **Yellow** | `apps/**`, the non-kernel `packages/**` listed in `AGENTS.md`, `.openslack/self/eval_suites/**`, and every unmatched path                                                                                                         | With independent agent review | No             |
| **Red**    | `AGENTS.md`, `CLAUDE.md`, `.github/**`, `.openslack/policies/**`, `.openslack/agents/registry/**`, `.openslack/agents/prompts/**`, `.openslack/plugins/**`, `.openslack/plugins.lock`, `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, `packages/kernel/src/**`, `packages/plugin-host/**` | Never                         | Yes            |
| **Black**  | `.env`, `**/*.pem`, `**/*.key`, `secrets/**`, `credentials/**`, `private/**`, `production-tokens/**`                                                                                                                              | Never (auto-reject)           | N/A            |

Green is an explicit allowlist, not a default. A new package, root manifest, or
otherwise unrecognized path is Yellow until governance deliberately classifies it.

## Agent Rules (Always Enforced)

1. **No self-approval** — Agent cannot review or merge its own PR
2. **No self-prompt-edit** — Agent cannot modify prompt/registry
3. **No policy bypass** — Agent cannot skip validation
4. **No direct main push** — All changes via PR
5. **No secret access** — Agents never read/write credential files

## Constitutional Paths

These require human approval for ANY change:

- `.openslack/self/constitution.md`
- `.openslack/self/invariants.yaml`
- `.openslack/policies/constitutional_paths.yaml`
- `.openslack/policies/self_evolution.yaml`

## Rollback

When regression detected:

1. `monitorPostMerge()` flags regression
2. `createRollbackTask()` creates EVOL task
3. `scripts/genesis-rollback.sh` generates revert
