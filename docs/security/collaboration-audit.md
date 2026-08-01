---
schema: openslack.document.v1
id: security-collaboration-audit
status: In Review
authority: canonical
audience:
  - security
owner: security
updated: 2026-08-01
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Collaboration Audit

## Scope

The Collaboration Audit defines what the Collaboration Layer records, what it never records, and how sensitive data is protected.

## What Is Logged

The Collaboration Layer records collaboration events that are safe to observe:

- Event ID and timestamp
- Event type (e.g., `pr.doctor.ready`, `plan.created`)
- Actor ID and kind (human/agent/system/github/chat)
- Provider (cli/slack/webhook/github)
- Object kind and ID (issue/PR/plan/module/agent/handoff/decision/workspace/workflow/graph)
- Source reference (which system emitted the event)
- Summary (safe, non-sensitive description)
- Owner and next action (who should act next)
- Risk level and severity
- Correlation and parent event IDs
- Metadata (after redaction check)

## What Is Never Logged

The Collaboration Layer never records:

- Tokens (Slack bot token, GitHub token, OAuth tokens)
- Signing secrets (Slack signing secret, webhook secret)
- Private keys (SSH keys, GPG keys)
- Credential values (passwords, API keys, .env contents)
- Raw webhook payloads containing secrets
- Full chat message text (only intent kind and hash)
- Personal identifiable information not relevant to collaboration
- Graph mirror endpoints, canonical request bodies, nodes, edges, titles, explanation target
  payloads, authority objects, evidence contents, or source-event contents

GS3-A Graph read-mirror events store only the operation/outcome, bounded status or difference
codes, latency, and SHA-256 fingerprints/digests (including a hashed snapshot cursor). Mirror
events remain local runtime observations and never establish Go read authority. If the bound audit
append fails, the MCP result remains TypeScript-authoritative and the process emits only the fixed
`OPENSLACK_GRAPH_READ_MIRROR_AUDIT_FAILED` stderr diagnostic.

## Redaction Rules

All event metadata passes through `sanitizeEvent()` before write.

### Secret Patterns

| Pattern          | Example                           | Action       |
| ---------------- | --------------------------------- | ------------ |
| Slack token      | `xoxb-1234567890-...`             | Reject write |
| GitHub token     | `ghp_abcdef123...`                | Reject write |
| Private key      | `-----BEGIN RSA PRIVATE KEY-----` | Reject write |
| AWS secret       | `AWS_SECRET_ACCESS_KEY=...`       | Reject write |
| OpenSlack secret | `OPENSLACK_WEBHOOK_SECRET=...`    | Reject write |

### Redaction Policy

- Safe summaries: may be redacted
- Raw metadata with secrets: **always rejected**, never silently redacted
- If `containsSensitiveData` is true, the event is invalid and cannot be written

## Retention

- Local runtime events (`.openslack.local/collaboration/events.jsonl`): not committed, managed by local cleanup
- Workspace collaboration objects (`.openslack/collaboration/`): committed to Git, follow repository retention
- Derived reports (`.openslack.local/collaboration/digests/`): not committed, regenerable

## Local vs Workspace Audit

| Layer             | Path                                          | Committed | Contents                                     |
| ----------------- | --------------------------------------------- | --------- | -------------------------------------------- |
| Local runtime     | `.openslack.local/collaboration/events.jsonl` | No        | Chat traces, operator traces, runtime events |
| Workspace objects | `.openslack/collaboration/`                   | Yes       | Handoffs, decisions                          |
| Derived reports   | `.openslack.local/collaboration/digests/`     | No        | Digest summaries                             |

## Chat Security Boundary

Chat messages produce events, but the Collaboration Layer does not:

- Store full message text (only message ID, hash, intent kind)
- Store Slack token or signing secret
- Treat Slack confirmation alone as GitHub approval
- Allow agent-originated PR approval decisions

For the human approval definition, see `docs/security/human-approval.md`.

## Verification

```bash
# Check that events.jsonl exists and is in .gitignore
cat .openslack.local/collaboration/events.jsonl | head -5

# Check that no secrets appear in events
grep -E "xox[baprs]-|gh[pousr]_|PRIVATE KEY" .openslack.local/collaboration/events.jsonl
# Expected: no matches

# Check workspace collaboration directory structure
ls .openslack/collaboration/
```
