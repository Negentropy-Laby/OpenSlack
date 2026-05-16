# Self-Evolution Kernel — Developer Guide

OSEK (OpenSlack Self-Evolution Kernel) is the first OpenSlack module. It makes OpenSlack able to safely validate, improve, and govern itself.

## Architecture

```
openslack/
├── openslack.yaml              # Self-Project Mode workspace
├── .openslack/                 # Workspace state
│   ├── self/constitution.md    # 6-article constitution
│   ├── self/invariants.yaml    # 7 immutable rules
│   ├── policies/               # 6 policy files
│   └── eval_suites/golden/     # 7 golden evals
├── packages/
│   ├── kernel/                 # Zone classifier, merge decision, invariants
│   ├── workspace/              # Validation, indexing, schemas, golden evals
│   ├── self-evolution/         # Observe, triage, review, scorecard, monitor, rollback
│   ├── core/                   # Claim Broker (lease state machine)
│   ├── agent-runtime/          # Agent bootstrap + tick
│   ├── git-sync/               # Worktree manager, PR proposal
│   └── github-provider/        # GitHub API client (dry-run when no token)
├── apps/cli/                   # CLI — 6 command groups
├── scripts/                    # genesis-validate.sh, genesis-rollback.sh
└── .github/workflows/          # 4 CI workflows
```

## Core Loop

```
OBSERVE → CLASSIFY → VALIDATE → REVIEW → SCORECARD → MERGE → MONITOR → ROLLBACK
```

## Key Commands

| Command | Purpose |
|---------|---------|
| `openslack workspace validate` | Validate Self-Project workspace |
| `openslack self classify-pr --paths "..."` | Classify PR risk zone |
| `openslack self eval --suite golden` | Run 7 golden evals |
| `openslack self observe` | Check health |
| `openslack self triage` | Create EVOL tasks from observations |
| `openslack agent hire --agent-id <id>` | Create onboarding package |
| `openslack agent bootstrap --agent-id <id>` | Verify agent readiness |
| `openslack agent tick --agent-id <id>` | Run agent work cycle |
| `openslack task sync --paths "..."` | Generate workspace PR body |
| `openslack self review --pr <n> --implementer <a> --reviewer <b>` | Review PR |
| `openslack self scorecard --experiment <id>` | Compute fitness score |
| `openslack self monitor --experiment <id>` | Post-merge regression check |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test             # 97 tests, 12 test files
node --import tsx apps/cli/src/index.ts <command>
bash scripts/genesis-validate.sh
```
