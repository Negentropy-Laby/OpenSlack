---
schema: openslack.document.v1
id: evidence-qoder-work
status: In Review
authority: canonical
audience:
  - contributors
owner: qa
updated: 2026-07-30
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Qoder Work Integration Evidence

This record preserves the historical repository-local and unauthenticated observations, then
records the final candidate-bound local Qoder Work Desktop and controlling-TTY qualifications. It
contains no token, session, account, raw connector configuration, authentication file, raw vendor
body, or credential material.

## Verdict

| Boundary                                   | Verdict                              | Meaning                                                                                                    |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| OpenSlack MCP build and tests              | `LOCAL_PASS`                         | The read-only MCP frontend builds and passes repository tests.                                             |
| MCP SDK over production STDIO entrypoint   | `LOCAL_PASS`                         | The exact production catalog and result envelope were exercised against the committed CLI entrypoint.      |
| Qoder Skill structure and discovery        | `LOCAL_PASS`                         | The Skill validator passes and Qoder Work discovers the installed Skill.                                   |
| Qoder CLI `/Skill` conversation            | `BLOCKED_NOT_LOGGED_IN` (historical) | The earlier official CLI observation stopped before model or MCP execution and requested `/login`.         |
| Human-attested production-17 local profile | `HUMAN_ATTESTED_PROFILE_LOCAL_PASS`  | A real Windows controlling TTY approved the isolated synthetic effect with durable CAS and audit readback. |
| Qoder Work desktop stock connector         | `QODER_VERIFIED`                     | Qoder Work `0.9.12.0` initialized and exercised the exact stock 12-tool profile and all three Skill modes. |

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

## Historical QG5 governed-mutation qualification

This pre-final-candidate local qualification preserved the QG4 read-only stock profile and tested
the optional governed profiles through explicitly injected composition ports. Its `NOT_RUN` and
`NOT_CLAIMED` rows are retained as historical evidence and are superseded only by the final
candidate-bound qualification recorded below.

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

## Historical local human-attested CLI qualification

This pre-final-candidate snapshot recorded the production CLI surface before the Desktop
qualification below. The production CLI exposes `human-attested`, but only after a separate local
provider passes its startup self-test. The mapping at
`.openslack.local/mcp/human-subjects.json` stores a one-way OS-subject hash and asserted human
principal, never a raw uid, username, SID, or credential. Mapping reads are bounded, canonical,
no-follow, owner checked, and process-sealed by byte hash and file identity. Windows additionally
requires provable current-SID ownership and protected ACLs.

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

At that time, Qoder Work could launch a stdio child without a controlling TTY. That was an expected
fail-closed outcome, not qualification evidence and not permission to read approval input from
protocol stdin. The final candidate qualification below subsequently proved connector
initialization, exact catalog discovery, observed permission behavior, Skill triggering, and the
independent local attestation channel.

## Final candidate-bound Desktop and controlling-TTY qualification

The final candidate was frozen after the v2 evidence contract and candidate-revision comparison
fixes merged. A detached, no-space Windows worktree passed frozen install, typecheck, two complete
zero-failure test runs, build, documentation generation and verification, migration and
Notification documentation checks, status verification, workspace validation, golden `7/7`, and
Genesis validation. The tracked worktree remained clean before and after qualification.

### Final revision binding

| Field                                    | Value                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Candidate commit                         | `23e6c168c880f2f7122094c86d22894cdf9ba628`                                 |
| Candidate tree                           | `49a2faec2d23f3b51cd2eb1647a651fcaaf1e5a1`                                 |
| Qoder Work build                         | `0.9.12.0`                                                                 |
| Platform                                 | Windows `x64`                                                              |
| Qualification ID                         | `qoder-desktop-23e6c168c880-3f224a5178ff`                                  |
| Skill SHA-256                            | `a6acdc5bd0ff398c15ebf9775c8fa5e19dbb9b6eae655e2af3742e5cf819647f`         |
| Credential-free Connector config SHA-256 | `8c7f8f5fc9da152faaad7e478d5d500204a7e04ebb4afede3480318c26df034e`         |
| Fixed call-plan SHA-256                  | `d810da39237bb00ead89f51624a4d73a8a20f6838b0bc7e5450dd40ec6c24fa4`         |
| Sealed v2 manifest SHA-256               | `e42aed876a24090d8c175549ea5c7d4e67df984c71f1a689c33e307e1851d61e`         |
| Verified v2 receipt SHA-256              | `814bd6bfe446ebe01836d63da1df979531f71f82940ec9f10c7d53eac2e6a314`         |
| Desktop observation window               | `2026-07-29T18:02:47.169Z` to `2026-07-29T18:26:25.123Z`                   |
| Verifier result                          | `openslack.qoder_desktop_qualification_verification.v2` / `QODER_VERIFIED` |

### Real controlling-TTY result

The production 17-tool composition ran through the official MCP SDK from the same candidate. The
current Windows OS subject was temporarily bound to `human:founder`; no raw SID, account name, uid,
username, or authentication material was retained. The human reviewed the exact synthetic,
local-only workflow effect and typed `APPROVE` on `CON`, independently of MCP stdin/stdout.

| Boundary                          | Result                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Exact production catalog          | `17` tools                                                                          |
| Human decision                    | `approved`                                                                          |
| Reason SHA-256                    | `42d1fc72ff7d6486df19a73584693f2194af5fdea79d068183c0579fc8ffbe9a`                  |
| Terminal CAS                      | revision `0` to `2`                                                                 |
| Audit projection                  | `recorded`                                                                          |
| Audit event                       | `WFAPPROVAL-AUDIT-d50ac2026d5d08027c3a6c949dee95ede440307395eba739ab50f0cf64849de1` |
| Temporary workspace and authority | removed                                                                             |
| Subject mapping                   | removed                                                                             |
| Approval store                    | removed                                                                             |
| Narrow claim                      | `HUMAN_ATTESTED_PROFILE_LOCAL_PASS`                                                 |

### Authenticated Desktop result

Qoder Work initialized the explicitly enabled credential-free STDIO Connector with `auth=none`
and listed exactly the 12 stock read-only tools in the sealed order. The old Connector and prior
grants were removed, Auto-run was disabled, and no wildcard rule was present. The Desktop then
executed every fixed call-plan entry:

| Result class | Count | Preserved blocker codes                                                          |
| ------------ | ----: | -------------------------------------------------------------------------------- |
| `completed`  |     7 | none                                                                             |
| `blocked`    |     3 | `WORKFLOW_RUN_NOT_FOUND`, `SOURCE_EVIDENCE_STALE`, `SOURCE_EVIDENCE_UNAVAILABLE` |
| `failed`     |     2 | `READ_PROJECTION_FAILED`                                                         |

All 12 results used `openslack.mcp_result.v2`. `openslack_list_scenarios` returned exactly the
locked `contract-to-delivery-lite` and `software-delivery` Packs. The stale graph fixture remained
`SOURCE_EVIDENCE_STALE`; the reserved missing instance remained
`SOURCE_EVIDENCE_UNAVAILABLE`.

Qoder Work displayed no permission prompt for these calls. The v2 verifier accepted the observed
`no_prompt_read_only_observed` outcome only because the live `tools/list` exactly matched the
sealed stock catalog and every tool advertised `readOnlyHint=true`, `destructiveHint=false`, and
`idempotentHint=true`; the reviewed `openWorldHint` values also matched exactly. These annotations
explain client UX and do not grant OpenSlack authority.

Automatic matching, the `/` chooser, and explicit
`/openslack-organization-control` each loaded the Skill and produced the required `Status`,
`Owner`, `Blocker`, `Next`, and `Evidence` sections. All three preserved blocked and unknown
states and identified fixtures and projections as non-live authority. The closed v2 receipt
contained only structured status, timestamps, hashes, and evidence references; the verifier
rejected credentials, account/authentication fields, raw vendor bodies, mutation tools, catalog
or annotation drift, wildcard rules, Auto-run, prior grants, and missing calls.

This result establishes `QODER_VERIFIED` only for the candidate-bound local stock STDIO Connector
and installed Skill. It does not promote a public remote Connector, OAuth, Marketplace,
Workbench, live Contract-to-Delivery capstone, Notification Delivery, release, production
readiness, GitHub approval, or external-system mutation.
