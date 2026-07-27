# Manufacturing 90-day pilot scenario

## Organization

The fixture organization is `华东精密制造有限公司`, a traditional discrete manufacturer whose
quality-exception process crosses production operations, quality management, and equipment
engineering.

The fixed input lives at
`examples/ai-organization-demo/input/manufacturing-90-day.json`. It sets:

- a 90-day maximum duration;
- a CNY 500,000 configured budget ceiling;
- a read-only, reversible pilot boundary;
- GitHub as the formal task, review, and delivery source of truth;
- zero agent approval or direct-main authority.

## Selected pilot

The fixture selects a quality-exception copilot. The copilot summarizes traceable evidence and
suggests next steps; it does not write to MES/QMS, approve a review, or merge a PR.

The displayed 12-hour baseline, 4-hour target, CNY 3,840,000 annualized value, and 6.68 simple
annual ROI are
`configured_estimate` values. They become `observed` only after a real pilot supplies traceable
measurement evidence. Observed revenue remains `unknown`.

## Digital employees

| Agent type                 | Responsibility                                  | Forbidden authority             |
| -------------------------- | ----------------------------------------------- | ------------------------------- |
| `business-discovery-agent` | Business context and process inventory          | Approval, merge                 |
| `data-inventory-agent`     | System, owner, readiness, and control inventory | Production write                |
| `roi-analyst-agent`        | Use-case selection and adversarial value checks | Revenue claims without evidence |
| `solution-architect-agent` | Reversible target architecture                  | Policy or permission mutation   |
| `risk-reviewer-agent`      | Risk register and human decision points         | GitHub Approval                 |
| `delivery-planner-agent`   | 90-day milestones and rollback triggers         | Direct-main delivery            |

The six agent registry entries are intentionally not part of QW0 core. They require their own Red
Zone PR and current-head human review. Until that lands, fixture mode and the sanitized recorded run
are the supported demo paths; live mode fails closed with `LIVE_AGENT_REGISTRY_MISSING`.

## GitHub rehearsal shape

A successful live rehearsal creates:

- one parent Issue: `制造企业 AI 转型试点`;
- seven child task Issues corresponding to the seven artifacts;
- one non-`main` demo branch;
- one bot-authored draft PR targeting canonical `main`.

Creating these objects does not approve or merge the PR.
