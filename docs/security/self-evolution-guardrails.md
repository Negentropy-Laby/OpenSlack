# Self-Evolution Guardrails

## Zone Classification

| Zone | Paths | Auto-Merge | Human Required |
|------|-------|-----------|---------------|
| **Green** | `docs/**`, `templates/**`, `.openslack/tasks/**`, `.openslack/self/scorecards/**` | Yes | No |
| **Yellow** | `apps/**`, `packages/core/**`, `packages/workspace/**`, `packages/github-provider/**`, `packages/agent-runtime/**`, `packages/git-sync/**`, `packages/self-evolution/src/ops/**`, `.openslack/self/eval_suites/**` | With agent review | No |
| **Red** | `.github/**`, `.openslack/policies/**`, `.openslack/agents/registry/**`, `.openslack/agents/prompts/**`, `.openslack/self/constitution.md`, `.openslack/self/invariants.yaml`, `packages/kernel/src/**`, `packages/self-evolution/src/core/**` | Never | Yes |
| **Black** | `.env`, `**/*.pem`, `**/*.key`, `secrets/**`, `credentials/**`, `private/**`, `production-tokens/**` | Never (auto-reject) | N/A |

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
