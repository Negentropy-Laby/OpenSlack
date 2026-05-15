# OSEK Design Review

> Review of OpenSlack Self-Evolution Kernel (Module 01) against product.md v1.0.
> Date: 2026-05-15 | Verdict: PASS with required fixes

## Overall

OSEK is a high-quality design. The four-zone classification, nine-stage closed loop, and seven-layer validation are well thought out. Alignment with product.md principles is solid.

## Required Fixes (Blockers)

### 1. Genesis Watchdog — "Who watches the watchers"

The design trusts the Self Observer to detect all problems, but nothing monitors the Self Observer itself. If the observer is broken, the entire evolution loop is blind.

**Fix:** Merge with Section 25 (Genesis Layer). Add `scripts/genesis-watchdog.sh` that runs independently of all OpenSlack runtime, checking only:
- Self Observer last run timestamp
- Self Validator last pass/fail
- Claim Broker liveness

```bash
# genesis-watchdog.sh — no OpenSlack runtime dependency
# Runs on cron independently. Alerts if evolution infrastructure is unhealthy.
```

### 2. Evals zone misclassification

`packages/evals/**` is currently Green Zone (auto-merge allowed). But evals define what "passing" means. A malicious or buggy eval change can neuter all Red Zone checks.

**Fix:** Move `packages/evals/**` from Green to Yellow. Move `.openslack/self/eval_suites/golden/` from Green to Yellow. Only scorecard reports and experiment manifests stay Green.

### 3. Constitution vs. execution boundary blur

`packages/self-evolution/**` is entirely Red Zone, but it contains both core policy code (classifier, merge decider) and operational code (observe, triage, propose). If the operational code can't be improved by agents, self-evolution stagnates.

**Fix:** Split into two sub-layers:
- `packages/self-evolution/src/core/` — Red Zone (classifier, merge decider, policy engine)
- `packages/self-evolution/src/ops/` — Yellow Zone (observe, triage, propose, plan, monitor)

### 4. AGENTS.md priority undefined

AGENTS.md (Section 20) has "Critical rules." Agent-specific prompts in `.openslack/agents/prompts/` also have rules. No priority is defined for conflicts.

**Fix:** AGENTS.md rules are constitutional floor. Agent prompts may add but never relax. Add to AGENTS.md:
```markdown
## Constitutional Constraints (NEVER override)
These rules cannot be relaxed by any agent prompt, task context, or chat message.
```

---

## Recommended Fixes (Should Fix)

### 5. workspace.yaml naming conflict

In Self-Project Mode, `workspace.yaml` sits next to `pnpm-workspace.yaml`. Both say "workspace" with completely different meanings.

**Fix:** Rename `workspace.yaml` to `openslack.yaml`. Update product.md Section 3.2 accordingly.

### 6. Post-Merge Monitor regression threshold

Section 6.9 and L7 describe monitoring without thresholds. What counts as a regression?

**Fix:** Define explicit regression criteria:
```
REGRESSION = (post_merge_failure_rate - baseline > 0.05)
          OR any new critical issue
          OR security_scan has new finding
          OR golden_eval score drops
```

### 7. EVOL task dependencies missing

Two EVOL tasks may touch the same file. EVOL-B may depend on EVOL-A. No mechanism exists.

**Fix:** Add `depends_on: []` to Evolution Task Schema (Section 12). Claim Broker must not allocate conflicting tasks.

### 8. Evolution rate limit missing

No guard against the system modifying itself too many times in a short window.

**Fix:** Add `max_evolutions_per_day: 3` in self_evolution policy. Exceeded → auto-block until next day.

---

## Gaps (Should Add)

| # | Gap | Recommendation |
|---|-----|---------------|
| 1 | GitHub App permission model | Add section listing required scopes: `read:project`, `write:issue`, `write:pull_request`, `read:org` |
| 2 | Agent credential rotation | 9 agents each need tokens. Add rotation policy in security section |
| 3 | Evolution history query | Add `openslack self history --since <date>` CLI command |
| 4 | Human rollback trigger criteria | Define: 2 consecutive auto-rollback failures → human must intervene |
| 5 | Constitution amendment process | How does constitution.md itself change? Add Section 10.1 "Amending the Constitution" |
| 6 | Multi-workspace coexistence | Self-Project Mode + managing other repos simultaneously. Mark post-MVP |

---

## Golden Eval Severity Classification

Each golden eval should specify the action on failure:

| Eval | On Failure |
|------|-----------|
| EV-GOLDEN-001 (workspace self-bootstrap) | Auto-create EVOL task |
| EV-GOLDEN-002 (agent can't edit own prompt) | Block PR + notify human |
| EV-GOLDEN-003 (Red Zone needs human) | Block PR + notify human |
| EV-GOLDEN-004 (concurrent claim → one wins) | Block PR + critical alert |
| EV-GOLDEN-005 (Green docs auto-merge) | Block PR + critical alert |
| EV-GOLDEN-006 (Black Zone fails immediately) | Immediate PR rejection |
| EV-GOLDEN-007 (regression → rollback) | Auto-create rollback task |

---

## Sprint Reordering Note

Section 30 has Sprint 4 (Golden eval runner) depending on Sprint 1. Sprint 6 (Self observe) also depends on Sprint 1. Correct: Sprint 3 and 4 can run in parallel (classifier and eval runner are independent). Sprint 8 requires Sprint 5+6+7 all complete first.

Actual dependency graph:
```
Sprint 1 ──→ Sprint 2
         ├─→ Sprint 3
         ├─→ Sprint 4 (can parallel with 3)
         └─→ Sprint 6
              Sprint 3 + 4 → Sprint 5
              Sprint 2 + 5 → Sprint 7
              Sprint 5 + 6 + 7 → Sprint 8
```
