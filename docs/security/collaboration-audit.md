# Collaboration Audit

## Scope

The Collaboration Audit defines what the Collaboration Layer records, what it never records, and how sensitive data is protected.

## What Is Logged

The Collaboration Layer records collaboration events that are safe to observe:

- Event ID and timestamp
- Event type (e.g., `pr.doctor.ready`, `plan.created`)
- Actor ID and kind (human/agent/system/github/chat)
- Provider (cli/slack/webhook/github)
- Object kind and ID (issue/PR/plan/module)
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

## Redaction Rules

All event metadata passes through `sanitizeEvent()` before write.

### Secret Patterns

| Pattern | Example | Action |
|---------|---------|--------|
| Slack token | `xoxb-1234567890-...` | Reject write |
| GitHub token | `ghp_abcdef123...` | Reject write |
| Private key | `-----BEGIN RSA PRIVATE KEY-----` | Reject write |
| AWS secret | `AWS_SECRET_ACCESS_KEY=...` | Reject write |
| OpenSlack secret | `OPENSLACK_WEBHOOK_SECRET=...` | Reject write |

### Redaction Policy

- Safe summaries: may be redacted
- Raw metadata with secrets: **always rejected**, never silently redacted
- If `containsSensitiveData` is true, the event is invalid and cannot be written

## Retention

- Local runtime events (`.openslack.local/collaboration/events.jsonl`): not committed, managed by local cleanup
- Workspace collaboration objects (`.openslack/collaboration/`): committed to Git, follow repository retention
- Derived reports (`.openslack.local/collaboration/digests/`): not committed, regenerable

## Local vs Workspace Audit

| Layer | Path | Committed | Contents |
|-------|------|-----------|----------|
| Local runtime | `.openslack.local/collaboration/events.jsonl` | No | Chat traces, operator traces, runtime events |
| Workspace objects | `.openslack/collaboration/` | Yes | Handoffs, decisions |
| Derived reports | `.openslack.local/collaboration/digests/` | No | Digest summaries |

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
