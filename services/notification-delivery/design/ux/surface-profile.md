# Product Surface Profile

> **Status**: Approved design classification

| Surface | Applicability | Audience | Authentication |
|---|---|---|---|
| Notification HTTP API | Required | internal business systems | Bearer API Key |
| Operator HTTP API | Required | internal operators/SRE | operator API Key + capability/scope |
| Vendor Admin HTTP API | Required | vendor configuration administrators | operator API Key + vendor-admin capability/scope |
| Metrics/health | Required | deployment/monitoring plane | network boundary, not business auth |
| CLI | Excluded from MVP | — | — |
| GUI/admin console | Excluded from MVP | — | — |
| SDK | Excluded from MVP | callers use OpenAPI | — |

This is a headless product, but not “no UX”: API error consistency, asynchronous acknowledgement, polling/query,
preview-before-execute and recovery guidance are integrator/operator interaction surfaces.

No visual identity, accessibility UI requirements or prototype screen is applicable. HTTP payload clarity, stable
errors and documentation navigation carry the relevant usability obligations.
