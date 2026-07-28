---
schema: openslack.document.v1
id: evidence-qoder-work
status: In Review
authority: canonical
audience:
  - contributors
owner: qa
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Qoder Work Integration Evidence

This record separates the repository-local MCP and Skill qualification from a real Qoder
conversation. It contains no token, session, account, connector configuration, or credential
material.

## Verdict

| Boundary                                 | Verdict                 | Meaning                                                                                               |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| OpenSlack MCP build and tests            | `LOCAL_PASS`            | The read-only MCP frontend builds and passes repository tests.                                        |
| MCP SDK over production STDIO entrypoint | `LOCAL_PASS`            | The exact production catalog and result envelope were exercised against the committed CLI entrypoint. |
| Qoder Skill structure and discovery      | `LOCAL_PASS`            | The Skill validator passes and Qoder CLI discovers the linked Skill as enabled.                       |
| Qoder CLI `/Skill` conversation          | `BLOCKED_NOT_LOGGED_IN` | The official client stopped before model or MCP execution and requested `/login`.                     |
| Qoder Work desktop connector execution   | `NOT_RUN`               | No authenticated desktop session was used.                                                            |
| `QODER_VERIFIED`                         | `NOT_CLAIMED`           | Local protocol evidence is not substituted for an authenticated Qoder run.                            |

## Observation Binding

| Field                                     | Value                                                              |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Observed at                               | `2026-07-26T20:10:51Z`                                             |
| Tested commit                             | `e9590db1ca763deb39489b3b9c6e2c966b19ddfc`                         |
| Skill tree                                | `dee33e1682e6fe8527d2c130e8c5efbec1fedc8a`                         |
| Credential-free MCP configuration SHA-256 | `8d2acd3074a4a2d5b1cc068d95c895e08386e194046d4f248fcd9bbb569303e6` |
| Qoder CLI                                 | `1.0.45`                                                           |
| Qoder Work desktop                        | file version `0.9.12`, product version `0.9.12.0`                  |
| Client account state                      | `Not logged in`                                                    |

The configuration digest binds the command, arguments, and working directory used for the
qualification without storing their raw local values in this record.

## Production STDIO Probe

The probe used `@modelcontextprotocol/sdk` as a direct client and launched the production
`openslack mcp serve --stdio` CLI path. Tool output was reduced to schema, status, blocker, and
text/structured-content equality metadata; projection contents were not recorded.

| Tool                                | Result      | Governance behavior                                  | Text equals structured result |
| ----------------------------------- | ----------- | ---------------------------------------------------- | ----------------------------- |
| `openslack_get_executive_overview`  | `completed` | read projection                                      | yes                           |
| `openslack_list_work_items`         | `completed` | read projection                                      | yes                           |
| `openslack_get_work_room`           | `completed` | read projection                                      | yes                           |
| `openslack_get_activity`            | `completed` | read projection                                      | yes                           |
| `openslack_get_workflow_progress`   | `blocked`   | missing run fails closed                             | yes                           |
| `openslack_get_pr_readiness`        | `failed`    | unavailable external readiness evidence fails closed | yes                           |
| `openslack_list_pending_approvals`  | `completed` | read projection                                      | yes                           |
| `openslack_get_business_outcomes`   | `completed` | read projection                                      | yes                           |
| `openslack_get_notification_status` | `completed` | read projection                                      | yes                           |
| `openslack_list_scenarios`          | `completed` | locked Scenario Pack catalog                         | yes                           |
| `openslack_query_graph`             | `blocked`   | missing graph snapshot fails closed                  | yes                           |
| `openslack_explain_graph`           | `blocked`   | missing graph snapshot fails closed                  | yes                           |

The server listed exactly these 12 tools. Every result used
`schema: "openslack.mcp_result.v2"`. No mutation, shell, GitHub approval, direct merge, policy
write, permission change, or arbitrary Scenario Pack loading tool was present.

## Repository Gates

- `bun run typecheck`: pass.
- `bun run test`: 390 test files and 4864 tests passed; 16 tests skipped by their existing
  environment gates.
- `bun run build`: pass.
- Qoder Skill `quick_validate.py`: `Skill is valid!`.
- Independent QG4 security review: no remaining P0 or P1 findings.

The full repository format check remains baseline-red only in the 58 imported
`services/notification-delivery` files already tracked by that subsystem. Changed QG4 files pass
Prettier and `git diff --check`.

## Qoder Boundary

Qoder CLI discovered `openslack-organization-control` as enabled. An explicit
`/openslack-organization-control` prompt was then run with strict, credential-free MCP
configuration. The official client returned:

```text
Not logged in · Please run /login
```

No login was attempted, no credential file was inspected, and no inference is made about desktop
connector behavior. A future authenticated qualification may append a new revision-bound record;
it must not rewrite this local-only verdict into live evidence.

## QG5 Governed Mutation Qualification

This later local qualification preserves the QG4 read-only stock profile and tests the optional
governed profiles through explicitly injected composition ports.

| Boundary                                       | Verdict       | Evidence                                                                  |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| Stock CLI catalog                              | `LOCAL_PASS`  | remains exact production-12 and projection-only                           |
| Agent-governed catalog                         | `LOCAL_PASS`  | exact production-16; preview, confirm, cancel                             |
| Separately human-attested catalog              | `LOCAL_PASS`  | exact production-17; one workflow-effect decision                         |
| Official MCP SDK governed transport sequence   | `LOCAL_PASS`  | preview → confirm → independently attested workflow decision              |
| Immutable plan and one-time confirmation       | `LOCAL_PASS`  | only token hash persisted; replay/drift/timeout fail closed               |
| Workflow decision and audit reconciliation     | `LOCAL_PASS`  | terminal CAS plus deterministic durable `pending`/`recorded` projection   |
| Audit path replacement and hardlink resistance | `LOCAL_PASS`  | fixed O_APPEND descriptor; 2500 replacement attempts captured zero writes |
| Independent QG5 security review                | `LOCAL_PASS`  | no remaining reproducible P0, P1, or P2 finding                           |
| Authenticated Qoder Work execution             | `NOT_RUN`     | prior `Not logged in` boundary unchanged                                  |
| `QODER_VERIFIED`                               | `NOT_CLAIMED` | local protocol evidence is not substituted for authenticated Qoder proof  |

### Revision binding

| Field                  | Value                                      |
| ---------------------- | ------------------------------------------ |
| Observed at            | `2026-07-26T21:54:14Z`                     |
| Governed plan core     | `a47ab482459b205d5c7358e05cbf58d6c1a54d21` |
| Scenario/workflow core | `cfd6328942668448d6067e1c87645121a83c8493` |
| MCP and audit frontend | `c16909053d5fb8c46c07743723a964cea172c18e` |
| Skill and contract     | `3c4a13bf7e4cce960dcf8f29ddf2ccc9d81ef43f` |

### Local gates

- `bun run typecheck`: pass.
- `bun run test`: 401 test files and 4967 tests passed; 16 tests remained skipped by existing
  environment gates.
- `bun run build`: pass.
- Qoder Skill `quick_validate.py`: `Skill is valid!`.
- Official MCP SDK and Bun direct suites: pass.
- Replacement race: 2500 successful appends, 2500 lines in the bound original log, zero captured
  files and zero captured lines.

The human-attested tool does not trust Skill wording, Qoder permission, IM identity, or a
client-supplied actor. Its host attests the exact run, approval, decision, reason hash, capability,
business correlation, and expiry for each call. The tool decides only an OpenSlack workflow
effect; it never creates a GitHub review or authorizes merge.

## Local human-attested CLI qualification

The production CLI now exposes `human-attested`, but only after a separate local provider passes
its startup self-test. The mapping at `.openslack.local/mcp/human-subjects.json` stores a one-way
OS-subject hash and asserted human principal, never a raw uid, username, SID, or credential.
Mapping reads are bounded, canonical, no-follow, owner checked, and process-sealed by byte hash and
file identity. Windows additionally requires provable current-SID ownership and protected ACLs.

| Boundary                                        | Verdict       | Evidence                                                                     |
| ----------------------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| Default / explicit read-only CLI                | `LOCAL_PASS`  | exact production-12; no authority-binding arguments                          |
| Agent-bound CLI                                 | `LOCAL_PASS`  | exact production-16 from registry/runtime principal                          |
| Human-attested CLI                              | `LOCAL_PASS`  | exact production-17 after independent provider self-test                     |
| Per-decision binding                            | `LOCAL_PASS`  | run, approval, decision, reason hash, capability, correlation, expiry        |
| Controlling-TTY separation                      | `LOCAL_PASS`  | `/dev/tty` or `CON`; no MCP stdin/stdout path                                |
| Subject/mapping/expiry/abort/confirmation drift | `LOCAL_PASS`  | fail closed before binding; requested profile has no 16/12 fallback          |
| Official MCP SDK decision and durable readback  | `LOCAL_PASS`  | exact 17 tools; terminal decision plus recorded audit projection             |
| Authenticated Qoder Work execution              | `NOT_RUN`     | controlling-TTY availability and Desktop connector execution remain external |
| `QODER_VERIFIED`                                | `NOT_CLAIMED` | local protocol and provider evidence are not Desktop qualification           |

Qoder Work may launch a stdio child without a controlling TTY. That is an expected fail-closed
outcome, not qualification evidence and not permission to read approval input from protocol
stdin. A named authenticated Desktop build must still prove connector initialization, exact
catalog discovery, tool permission behavior, Skill triggering, and the independent local
attestation channel before any `QODER_VERIFIED` claim.
