# New Agent Onboarding Guide

## Hiring a New Agent

```bash
openslack agent hire --agent-id codex_developer_ci-bot \
  --display-name "CI Bot" \
  --department engineering \
  --role developer \
  --runtime codex
```

This creates:

- `agents/registry/<agent_id>.yaml` — Registry entry
- `agents/onboarding/<agent_id>/` — 9 onboarding files

## Manual Steps After Hiring

1. Create local identity:
   ```
   .openslack.local/agents/<agent_id>/identity.yaml
   ```
2. Set credentials:
   ```yaml
   credentials:
     api_key_env: 'ANTHROPIC_API_KEY'
     github_token_env: 'GITHUB_TOKEN'
     openslack_token_env: 'OPENSLACK_AGENT_TOKEN'
   ```
3. Bootstrap:
   ```bash
   openslack agent bootstrap --agent-id <agent_id>
   ```
4. When bootstrap passes, agent is ready to work.

## Agent Files

| File                          | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `START_HERE.md`               | Entry point: identity, where tasks live, boundaries |
| `identity.yaml`               | Local credentials (never committed)                 |
| `github_task_contract.yaml`   | Project number, field mappings                      |
| `claim_policy.yaml`           | Lease TTL, heartbeat interval, concurrency          |
| `schedule.github-actions.yml` | GitHub Actions tick schedule                        |
| `codex_automation_prompt.md`  | Codex-native automation prompt                      |
| `claude_routine_prompt.md`    | Claude Code routine prompt                          |
| `local_cron.example`          | Local cron schedule                                 |
| `first_day_checklist.md`      | Bootstrap verification                              |
