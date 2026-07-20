# Agent Registration Standard v1.0

Every agent that works in an OpenSlack workspace must have a registry entry. This document defines the standard.

## Two-File Architecture

| File               | Location                                           | Git       | Contains                                                              |
| ------------------ | -------------------------------------------------- | --------- | --------------------------------------------------------------------- |
| **Registry entry** | `agents/registry/<agent_id>.yaml`                  | Committed | Identity, capabilities, permissions, task matching — no secrets       |
| **Local identity** | `.openslack.local/agents/<agent_id>/identity.yaml` | Ignored   | API keys, tokens, local paths, personal preferences — never committed |

**Principle:** The registry tells the company _who_ the agent is and _what_ it can do. The local identity tells the agent _how_ to authenticate and _where_ to work locally. Only the registry is shared.

## Agent ID Format

```
<provider>_<role>_<shortname>
```

| Component   | Description                   | Examples                                                          |
| ----------- | ----------------------------- | ----------------------------------------------------------------- |
| `provider`  | AI vendor or runtime          | `anthropic`, `openai`, `custom`, `local`                          |
| `role`      | Job function                  | `architect`, `developer`, `reviewer`, `researcher`, `sync`, `ops` |
| `shortname` | Unique identifier within role | `aby`, `ci-bot`, `pr-reviewer`, `mem-writer`                      |

Rules:

- All lowercase
- Underscore-separated components
- Shortname uses hyphens for multi-word (e.g., `ci-fix-bot`)
- Full agent_id must be unique across the workspace
- Once assigned, agent_id is immutable (retire and re-hire under a new ID if role changes)

## Registry Entry Schema

Every `agents/registry/<agent_id>.yaml` must validate against this structure:

```yaml
# Required: schema identifier for validation
schema: openslack.agent_registry.v1

# Required: matches the filename
agent_id: '<provider>_<role>_<shortname>'

# Required: human-readable name
display_name: '<Display Name>'

# Required: identifies this as an AI agent entry
employee_type: ai_agent

# Required: vendor and runtime information
vendor:
  provider: '<anthropic | openai | custom | local>'
  runtime: '<claude_code | codex | custom_runner | aby_assistant>'
  model: '<default model identifier, optional>'

# Required: employment metadata
employment:
  status: '<active | paused | onboarding | retired>'
  hired_at: '<ISO 8601 timestamp>'
  hired_by: '<human:<id> | agent:<agent_id>>'
  department: '<department name>'
  role: '<role title>'
  manager: '<principal_id or human identifier>'

# Required: what this agent can do
capabilities:
  primary:
    - '<capability_1>'
    - '<capability_2>'
  secondary:
    - '<capability_3>'

# Required: which repos this agent may access
repositories:
  workspace_repo:
    owner: '<github-org>'
    repo: '<repo-name>'
    default_branch: 'main'
  allowed_product_repos:
    - '<org>/<repo>'

# Required: workspace path permissions
workspace_permissions:
  allow:
    - '<glob pattern>'
  deny:
    - '<glob pattern>'

# Required: execution constraints
execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 60
  heartbeat_interval_minutes: 10
  max_task_runtime_minutes: 120
  max_daily_tasks: 12

# Required: what outputs the agent must/may/must-not produce
output_contract:
  must_create:
    - 'workspace_run_record'
  may_create:
    - 'product_pr'
    - 'workspace_pr'
    - 'review_comment'
  must_not_create:
    - 'direct_main_push'
    - 'production_deploy'
    - 'external_customer_message'

# Required: events that require human sign-off
approval_rules:
  require_human_approval_for:
    - 'merge_to_main'
    - 'production_deploy'
    - 'policy_change'
    - 'permission_change'

# Optional: GitHub Project task matching (for employee agents)
task_matching:
  github_owner: '<org>'
  github_project_number: <number>
  project_node_id: '<node-id>'
  allowed_statuses:
    - 'Ready'
  required_agent_types:
    - '<type>'
  required_capabilities_any:
    - '<cap>'
  excluded_labels:
    - 'human-only'
    - 'blocked'
  max_risk_level: 'medium'

# Optional: scheduling (for autonomous agents)
scheduler:
  preferred_mode: 'github_actions | local_cron | manual'
  cadence_minutes: 15
```

## Local Identity Schema

Every `.openslack.local/agents/<agent_id>/identity.yaml` must NOT be committed. Format:

```yaml
schema: openslack.agent_local_identity.v1

agent_id: '<agent_id>'

credentials:
  api_key_env: '<ENV_VAR_NAME>'
  github_token_env: '<ENV_VAR_NAME>'
  openslack_token_env: '<ENV_VAR_NAME>'

paths:
  workspace_root: '<absolute local path>'
  worktree_parent: '<absolute local path>'

preferences:
  default_editor: '<editor>'
  log_level: '<debug | info | warn | error>'
  notify_on: ['<event_types>']
```

## Registration Flow

```
Human or Hiring Agent
  │
  ├── Determine agent_id following the format
  ├── Create agents/registry/<agent_id>.yaml (commit)
  ├── Create .openslack.local/agents/<agent_id>/identity.yaml (do not commit)
  ├── Fill in credentials in identity.yaml
  ├── Commit and push registry entry
  └── Agent is now registered
```

## Immutable Fields

Once an agent is registered and working, these fields must never change:

- `agent_id`
- `hired_at`
- `hired_by`

To change an agent's role or capabilities, update the registry entry and submit through the standard workspace PR + review process. The agent cannot modify its own registry entry.

To decommission an agent, set `employment.status: retired` and record the retirement reason and date. Never delete registry entries — they are part of the company audit trail.
