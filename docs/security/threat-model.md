# Security Threat Model

## Assets and Trust Boundaries

Assets: vendor credentials, API keys, notification payloads, endpoint configuration, delivery/replay authority and
attempt/audit history.

Trust boundaries:

1. internal caller/operator to inbound TLS/API authentication;
2. application to PostgreSQL;
3. Delivery to secret provider;
4. Delivery to DNS and external vendor HTTPS;
5. metrics/health endpoints to deployment network.

## Threats and Controls

| Threat | Control | Evidence |
|---|---|---|
| arbitrary URL / SSRF | callers submit only `vendor_id`; Registry-owned HTTPS target | ADR-0004 |
| private/link-local/metadata access | validate every A/AAAA, deny non-public unless exact approved exception | ADR-0004 |
| DNS rebinding | dial validated IP, preserve original TLS hostname, no second resolve | ADR-0004 |
| redirect/proxy bypass | reject every redirect; environment proxy disabled | ADR-0004 |
| credential leakage | opaque `env://` ref, attempt-scoped resolution, log/metric/API denylist | ADR-0004 |
| API key theft | TLS, one-time display, HMAC digest+pepper, rotation/revocation, rate limit | ADR-0003 |
| caller/vendor enumeration | merged not-found/out-of-scope/disabled errors | CDD contracts |
| privilege escalation | server-derived kind/scope/capability; attenuation per call | ADR-0003 |
| replay abuse | preview read-only; execute re-authenticates; explicit IDs/versions; no query expansion | Operations CDD |
| duplicate vendor side effect | endpoint idempotency mapping when supported; risk disclosed | ADR-0002 |
| payload/header injection | byte/size bounds, closed Header allowlist, CR/LF controls | Vendor/Delivery CDD |
| audit tampering | append-only records, restricted DB role, OCC/transactional writes | ADR-0001 |
| denial of service | request/body/list/batch bounds, per-principal rate limits, hard HTTP timeout | CDD configs |
| deployment identity spoof/drift | require an exact deployment-supplied OCI digest at startup; successful intake overwrites any caller header with the process value | ADR-0005 / OpenAPI |

## Safe Outbound Transport

- Accept only Registry-parsed HTTPS targets.
- Resolve all A/AAAA records; if any is forbidden or an exception mismatch occurs, fail the entire attempt.
- Select only from the validated set and dial the selected `netip.Addr` directly.
- Set TLS `ServerName` to the original hostname and validate the normal certificate chain.
- Use a per-attempt transport or a pool whose key includes hostname+validated IP+policy generation; MVP chooses
  per-attempt, keep-alive-disabled transport for the simplest rebinding proof.
- Reject redirects, implicit proxies, credentials in URLs, userinfo, fragments and non-approved ports.
- `http_status_v1` reads no response body; `json_ack_v1` reads a bounded acknowledgement body and never persists it.

## Secret Handling

Registry permits only allowlisted `env://NAME` references. The startup configuration maps approved names to process
environment entries. Delivery resolves after snapshot authorization, keeps bytes in attempt scope, clears references
after request construction and never returns them. Missing or invalid secrets fail before network access.

The deployment digest is non-secret evidence metadata, but remains deployment-authoritative: the service never derives
or accepts it from request input. Missing, uppercase or malformed values fail during configuration loading before
database/network initialization. It is emitted only as the successful intake response header and is never written to
notification payload, Store rows, logs or metrics.

## Residual Risks

- A vendor that ignores idempotency keys may apply duplicates.
- Environment-based MVP secrets require process restart for rotation and are weaker than managed KMS/Vault.
- In-memory rate limits are per process.
- Compromised deployment/database administrators remain privileged.

Each residual is accepted for MVP and has an evolution trigger; none is represented as eliminated.
