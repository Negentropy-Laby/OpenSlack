# Contract-to-Delivery Lite

Contract-to-Delivery Lite is the single lead interview scenario.

## User goal

> A company has signed an AI workflow transformation contract. Establish a delivery project and
> complete security review, GitHub integration, and demonstration materials within two weeks.

## Business ontology

```text
Customer
Contract
Project
Milestone
Deliverable
Acceptance
Outcome
```

It reuses the software-delivery subgraph:

```text
Contract
  -> activates Project
  -> decomposes to Milestone
  -> contains Work Item
  -> implemented by GitHub Issue
  -> produces Pull Request
  -> reviewed by Human Review
  -> accepts Deliverable
  -> contributes to Outcome
```

## Read-only demonstration

1. Read `openslack_get_executive_overview`.
2. List `openslack_list_scenarios`.
3. Query the selected instance with `openslack_query_graph`.
4. Explain the Project, blocked Milestone, or Deliverable with `openslack_explain_graph`.
5. Read workflow progress, PR readiness, pending governance, outcomes, and notification status as
   needed.
6. Present Status / Owner / Blocker / Next / Evidence.

The current Skill does not instantiate the scenario or start a workflow. If the scenario is not
already present, report that the connected surface is read-only.

The manufacturing 90-day workflow is a deterministic technical fixture/fallback. It is not a
second live lead scenario. Any employee-onboarding view is static fixture evidence only.
