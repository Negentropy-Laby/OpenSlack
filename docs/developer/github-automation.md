# GitHub Automation — Complete Setup Guide

OpenSlack can fully configure its own GitHub environment without opening the web UI. This document covers all automation paths.

## Quick Start

```bash
# 1. Install gh + authenticate
bash scripts/setup-gh.sh --auth

# 2. Verify setup
openslack github doctor

# 3. Auto-create Project v2
openslack github project-init
```

## Automation Paths

### Path A: GitHub CLI (Recommended)

`scripts/setup-gh.sh` auto-installs `gh` on any platform:

| Platform | Installer |
|----------|-----------|
| Windows | winget |
| macOS | brew |
| Debian/Ubuntu | apt |
| Fedora/RHEL | dnf |
| Alpine | apk |
| Fallback | Direct download from releases |

Required scopes: `repo`, `read:project`, `project`

### Path B: GitHub REST/GraphQL API (Headless)

All operations can be performed via REST API without `gh`:

```bash
# Create Project v2
curl -X POST https://api.github.com/repos/wsman/OpenSlack/projects \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"OpenSlack Evolution Board"}'

# Query Project node ID
curl -X POST https://api.github.com/graphql \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"query":"query { repository(owner:\"wsman\",name:\"OpenSlack\") { projectsV2(first:1) { nodes { id } } } }"}'

# Create single-select field
curl -X POST https://api.github.com/graphql \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"query":"mutation { addProjectV2Field(input:{projectId:\"PVT_...\",name:\"Status\",dataType:SINGLE_SELECT,options:[{name:\"Ready\",color:GREEN}]}) { projectV2Field { id } } }"}'

# Branch protection
curl -X POST https://api.github.com/repos/wsman/OpenSlack/rulesets \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"OpenSlack Main Protection","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/main"]}},"rules":[{"type":"pull_request"},{"type":"deletion"},{"type":"non_fast_forward"}]}'
```

### Path C: openslack github project-init (Incomplete)

The `openslack github project-init` command will call the GraphQL API to:
1. Create Project v2 if it doesn't exist
2. Create all 14 standard fields
3. Populate single-select options
4. Write field IDs back to `.openslack/integrations/github.yaml`

This command is planned but not yet implemented. It will be added in a future phase.

## Current Capabilities

| Operation | Automated? | Command |
|-----------|-----------|---------|
| Install gh CLI | Yes | `bash scripts/setup-gh.sh` |
| Authenticate gh | Yes | `gh auth login --scopes repo,read:project,project` |
| Check readiness | Yes | `openslack github doctor` |
| Query Project fields | Yes | `openslack github project-inspect` |
| Query Ready items | Yes | `openslack github project-query-ready` |
| Create Project v2 | Manual | GitHub UI or `gh project create` |
| Create fields | Manual | GitHub UI or GraphQL mutation |
| Branch protection | Manual | GitHub UI or REST API |

## Required Token Scopes

| Scope | Needed For |
|-------|-----------|
| `repo` | Read/write repo contents, create PRs |
| `read:project` | Query Project v2 fields and items |
| `project` | Create/update Project v2 fields and items |
| `read:org` | Read organization metadata (optional) |

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `GITHUB_TOKEN` | Yes (for runtime) | — |
| `GITHUB_OWNER` | No | `wsman` |
| `GITHUB_REPO` | No | `OpenSlack` |
| `OPENSLACK_PROJECT_NODE_ID` | No | Read from `github.yaml` |
