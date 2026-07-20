# First Day Checklist for {{AGENT_ID}}

## Read

- [ ] `workspace.yaml` (or `openslack.yaml`)
- [ ] `agents/registry/{{AGENT_ID}}.yaml`
- [ ] `agents/prompts/{{AGENT_ID}}.md`
- [ ] `agents/onboarding/{{AGENT_ID}}/START_HERE.md`
- [ ] `policies/risk.yaml`
- [ ] `policies/workspace_write_permissions.yaml`
- [ ] `policies/claim_policy.yaml`
- [ ] `.openslack.local/agents/{{AGENT_ID}}/identity.yaml`

## Verify

- [ ] Can query GitHub Project #{{PROJECT_NUMBER}}
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
