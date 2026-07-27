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

## Foundation demonstration

1. Read `openslack_get_executive_overview`.
2. List `openslack_list_scenarios`.
3. Query the selected instance with `openslack_query_graph`.
4. Explain the Project, blocked Milestone, or Deliverable with `openslack_explain_graph`.
5. Read workflow progress, PR readiness, pending governance, outcomes, and notification status as
   needed.
6. Present Status / Owner / Blocker / Next / Evidence.

If the connected profile is read-only and the scenario is not already present, report that
boundary. If the exact governed profile is active, read first, preview the registered
Contract-to-Delivery Scenario, show the immutable effects and risk, wait for explicit
confirmation, then confirm with the returned one-time capability. Do not invent an instance or
Workflow when either tool is absent.

The manufacturing 90-day workflow is a deterministic technical fixture/fallback. It is not a
second live lead scenario. Any employee-onboarding view is static fixture evidence only.
