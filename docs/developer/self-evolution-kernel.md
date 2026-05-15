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
│   ├── policy/                 # Zone classifier (green/yellow/red/black)
│   ├── self-evolution/         # Core (classify-pr, merge-decider) + Ops (observe, triage, review, scorecard, monitor, rollback)
│   ├── workspace-engine/       # Workspace validation
│   ├── evals/                  # Golden eval runner
│   ├── core/                   # Claim Broker (lease state machine)
│   ├── agent-runtime/          # Agent bootstrap + tick
│   └── git-sync/               # Workspace PR proposal
├── apps/cli/                   # CLI (17 commands)
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
| `openslack sync propose --paths "..."` | Generate workspace PR body |
| `openslack review pr --pr <n> --implementer <a> --reviewer <b>` | Review PR |
| `openslack review scorecard --experiment <id>` | Compute fitness score |
| `openslack monitor check --experiment <id>` | Post-merge regression check |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test             # 60 tests, 7 test files
node --import tsx apps/cli/src/index.ts <command>
bash scripts/genesis-validate.sh
```
