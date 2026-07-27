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
