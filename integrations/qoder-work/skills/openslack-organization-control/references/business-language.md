# Business Language

Translate technical evidence without changing its meaning.

| Technical evidence       | Manager-facing language           |
| ------------------------ | --------------------------------- |
| Workflow run             | Governed delivery process         |
| Phase                    | Delivery stage                    |
| Work item / Issue        | Assigned unit of work             |
| PR                       | Reviewable deliverable            |
| PRMS readiness           | Delivery governance readiness     |
| Handoff                  | Ownership transfer                |
| Decision                 | Recorded management decision      |
| Scenario instance        | One bounded business initiative   |
| Graph node               | Business or delivery object       |
| Graph edge               | Evidence-backed relationship      |
| Correlation ID           | End-to-end trace ID               |
| Evidence reference       | Source trace                      |
| `demo_fixture`           | Demonstration-only data           |
| `configured_estimate`    | Declared planning assumption      |
| `unknown`                | Not supported by current evidence |
| Notification `accepted`  | Accepted by the delivery service  |
| Notification `delivered` | Observed vendor delivery          |

## Translation rules

- Preserve exact status tokens once, then explain them in plain language.
- Name the current owner rather than saying “the system.”
- Describe a blocker as the unmet evidence or decision, not as generic delay.
- Make Next a concrete read-only check or a human/external action already present in evidence.
- Cite evidence references; do not replace them with confident prose.
- Report observed, configured estimate, demo fixture, incomplete, and unknown separately.
- Do not report revenue, approval, acceptance, delivery, or completion without typed authority.

## Required answer shape

```text
Status: <exact token plus plain-language interpretation>
Owner: <evidence-backed actor or unknown>
Blocker: <unmet evidence/decision or none observed>
Next: <one bounded next action>
Evidence: <bounded references and observation time>
```
