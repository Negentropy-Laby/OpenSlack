# Branch Protection Ruleset

> Target: `Negentropy-Laby/OpenSlack` repository, `main` branch
> Required action: Human admin with GitHub Settings access
> Automation path: None (GitHub App token lacks `Administration` permission by design)

## Why This Matters

AGENTS.md constitutional rule #1: **"No direct push to main. All changes go through PRs."**

Without branch protection, any collaborator with write access can push directly to `main`, bypassing:
- PR review
- CI checks (classify, validate, canary)
- Zone classification (Red/Black zone gating)
- Audit trail

## Required Ruleset Configuration

### Target
- **Branch target:** `main`
- **Apply to:** Default branch only

### Rules

| Rule | Setting | Rationale |
|------|---------|-----------|
| **Require a pull request before merging** | ✅ Enabled | Constitutional requirement |
| **Require approvals** | 1 | Minimum independent review |
| **Dismiss stale PR approvals when new commits are pushed** | ✅ Enabled | Prevent approval farming |
| **Require review from CODEOWNERS** | ✅ Enabled | Human gate for protected paths |
| **Require status checks to pass** | ✅ Enabled | CI is the quality gate |
| **Status checks:** | | |
| → `classify` | Required | OSEK zone classifier |
| → `validate` | Required | Full validation suite |
| → `canary` | Required | Canary bootstrap + eval |
| **Block force pushes** | ✅ Enabled | Prevent history rewriting |
| **Require linear history** | ❌ Disabled | Merge commits are acceptable |
| **Require signed commits** | ❌ Disabled | Not all agents use GPG signing |
| **Require conversation resolution before merging** | ✅ Enabled | Ensure all review threads closed |
| **Require deployments to succeed** | ❌ Disabled | No deployment pipeline yet |

### Bypass
- **Bypass list:** Empty
- **Do not allow bypassing the above settings** | ✅ Enabled

## CODEOWNERS (Prerequisite)

Create `CODEOWNERS` at repository root before enabling "Require review from CODEOWNERS":

```
# Global fallback
* @wsman

# Protected paths — require human review
.github/**                  @wsman
.openslack/policies/**      @wsman
.openslack/self/constitution.md @wsman
.openslack/self/invariants.yaml @wsman
packages/kernel/src/**      @wsman
packages/plugin-host/**     @wsman
.openslack/plugins/**       @wsman
.openslack/plugins.lock     @wsman
```

## Verification Steps

After ruleset is applied:

1. Create a test PR from a branch (e.g., `docs/test-branch-protection`)
2. Verify the PR shows:
   - "Merging is blocked" until checks pass
   - "1 approving review required" from CODEOWNERS
3. Verify checks run:
   - `classify` → posts zone comment
   - `validate` → runs typecheck, lint, tests, eval
   - `canary` → runs bootstrap + eval + classify-pr
4. Merge the test PR and verify:
   - `OpenSlack Issue Done` workflow triggers
   - Issue is completed if PR body contains `Issue: #N`

## Rollback

If the ruleset is too restrictive and blocks legitimate emergency fixes:

1. GitHub Settings → Rules → Rulesets
2. Disable the ruleset (do not delete — keeps config)
3. Fix the blocking issue
4. Re-enable the ruleset

**Emergency direct push should never be needed.** If CI is broken, fix CI through a PR from a branch.
