# OpenSlack vendor templates

These templates are deployment inputs, not live configuration. Render every `${...}` placeholder in a protected
deployment workspace, submit through the authenticated vendor-admin API, and retain the resulting vendor in `draft`
until IB4 D4-0 authorizes concrete Canary resources. An unused rendered vendor must be moved to `disabled`; these
templates never activate a vendor.

- `openslack-slack-v2.yaml` uses schema v2 bearer auth, `json_ack_v1`, and no outbound idempotency rewrite because
  OpenSlack already materializes `client_msg_id` in the final body.
- `openslack-webhook-v2.yaml` uses schema v2 `auth:none`, status-only acknowledgement, and maps the ingress key to
  both frozen idempotency headers without changing the body.

Do not commit rendered vendor IDs, endpoint targets, credential handles, API keys, or Canary resource identifiers.
