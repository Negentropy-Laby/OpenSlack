---
schema: openslack.document.v1
id: cdd-module-index
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: product
updated: 2026-07-28
sources:
  - design/cdd/product-concept.md
  - .openslack/modules.yaml
---

# OpenSlack Module and Workstream Index

## Product Modules

| Module              | CDD                                | Runtime telemetry                          |
| ------------------- | ---------------------------------- | ------------------------------------------ |
| Self-Evolution      | [CDD](modules/self-evolution.md)   | `.openslack/modules.yaml#self_evolution`   |
| GitHub Task Loop    | [CDD](modules/github-task-loop.md) | `.openslack/modules.yaml#github_task_loop` |
| Operator            | [CDD](modules/operator.md)         | `.openslack/modules.yaml#operator`         |
| PR Review and Merge | [CDD](modules/pr-review-merge.md)  | `.openslack/modules.yaml#pr_review_merge`  |
| Collaboration       | [CDD](modules/collaboration.md)    | `.openslack/modules.yaml#collaboration`    |

## Workstreams

| Workstream             | CDD                                                 | Primary boundary                  |
| ---------------------- | --------------------------------------------------- | --------------------------------- |
| Notification Delivery  | [CDD](workstreams/notification-delivery/README.md)  | `services/notification-delivery`  |
| Plugin Platform        | [CDD](workstreams/plugin-platform/README.md)        | `packages/plugin-*`               |
| Agent Runtime and Aby  | [CDD](workstreams/agent-runtime-and-aby/README.md)  | `packages/agent-runtime`          |
| Workflow Runtime       | [CDD](workstreams/workflow-runtime/README.md)       | `packages/workflows`              |
| Organization Graph     | [CDD](workstreams/organization-graph/README.md)     | `packages/organization-graph`     |
| Scenario Runtime       | [CDD](workstreams/scenario-runtime/README.md)       | `packages/scenario-runtime`       |
| Qoder Work             | [CDD](workstreams/qoder-work/README.md)             | `packages/qoder-adapter`          |
| Negentropy Integration | [CDD](workstreams/negentropy-integration/README.md) | `packages/integration-negentropy` |
| Profile Sync           | [CDD](workstreams/profile-sync/README.md)           | `packages/workflows`              |
| TUI Productization     | [CDD](workstreams/tui-productization/README.md)     | `packages/tui`                    |

Notification Delivery supporting boundaries:

- `docs/user/guides/notification-delivery-operations.md`
- `docs/contributor/notification-delivery/README.md`
- `docs/security/notification-delivery-boundary.md`
- `docs/evidence/notification-delivery-evidence.md`

All design documents are initially `In Review`. A Full independent design
review is required before any document becomes `Approved`.
