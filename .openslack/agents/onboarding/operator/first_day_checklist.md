# First Day Checklist for operator

## Read
- [ ] `workspace.yaml` (or `openslack.yaml`)
- [ ] `agents/registry/operator.yaml`
- [ ] `agents/prompts/operator.md`
- [ ] `agents/onboarding/operator/START_HERE.md`
- [ ] `policies/risk.yaml`
- [ ] `policies/workspace_write_permissions.yaml`
- [ ] `policies/claim_policy.yaml`
- [ ] `.openslack.local/agents/operator/identity.yaml`

## Verify
- [ ] Can query GitHub Project #1
- [ ] Can see Ready tasks
- [ ] Can call Claim Broker (dry-run)
- [ ] Can create heartbeat (dry-run)
- [ ] Can create workspace worktree
- [ ] Can create draft PR (dry-run)
- [ ] Can stop cleanly when idle

## Do Not
- [ ] Claim a real task until bootstrap passes
- [ ] Modify policy files
- [ ] Modify your own registry or prompt
- [ ] Push to main
