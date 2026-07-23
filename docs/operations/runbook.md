# Operations Runbook

> B6 本地运行手册。示例 secret 和 destructive drill 只允许用于隔离验收环境；生产密钥管理、备份
> 调度和通知通道由部署方提供。

## Local Start

```bash
docker compose --env-file deploy/local.env.example up --build --wait
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/health/version
curl --fail http://127.0.0.1:8080/metrics
```

The local env file supplies an explicit public non-production deployment-digest fixture. Canary/production must
replace it with the deployment platform's verified OCI digest in exact `sha256:<64 lowercase hex>` form. Never use an
application-generated value or a default. Missing/malformed values must terminate startup before PostgreSQL or any
listener is initialized.

After deployment, submit a scoped canary notification and verify that the accepted response contains exactly:

```http
X-Notification-Service-Deployment-Digest: sha256:<verified OCI digest hex>
```

Verify both a first acceptance and an idempotent replay. A caller-supplied header with the same name must not alter
the response. A mismatch is a deployment/configuration incident; stop routing new intake and do not rewrite stored
notifications.

`GET /health/version` returns a closed JSON object with only `ready` and `deployment_digest`; it is 200 only while
ready and 503 otherwise. Canary automation must compare this value with the frozen OCI digest before enabling new
OpenSlack route admission.

Compose 启动 PostgreSQL 18.4、非 root app image 和 Prometheus 3.13.1。`/metrics` 必须恰有三项
`rc_wsman_*` 业务 gauge；Prometheus scrape timeout 为 5s，app collection timeout 为 2s。

## Signals

| Signal | Meaning | First action |
|---|---|---|
| outbox depth rising | intake exceeds delivery or workers cannot progress | inspect oldest age and readiness |
| oldest pending age rising | delivery latency/backlog | inspect Store/worker/vendor errors |
| dead count > 0 for 5m | at least one cycle needs operator decision | list dead and group by vendor/reason |
| readiness false | database/config/secret dependency unavailable | stop routing new traffic |
| worker health event | internal contract/config/deadline path failed | inspect stable error code and request ID |

Collection failure is unknown, never healthy zero.

## Backlog Triage

1. Confirm PostgreSQL readiness and schema compatibility.
2. Compare pending/in-flight/dead counts and oldest pending age.
3. Check worker health events without reading payload or secret material.
4. Group failures by stable vendor ID and sanitized result/reason.
5. Confirm vendor lifecycle and active endpoint version.
6. Do not bypass Store, edit rows manually or start a second ad-hoc delivery process.

## Dead Notification Recovery

1. Confirm the external vendor has recovered and evaluate duplicate-side-effect risk.
2. Query the notification and attempt history.
3. Preview explicit notification IDs with a meaningful justification.
4. Record the returned `expected_version`; preview does not reserve state.
5. Execute explicit `{notification_id, expected_version}` items.
6. Review succeeded/skipped/failed arrays individually.
7. If the response is lost or outcome unknown, query state/version/history; never blindly resubmit.

Batch maximum is 100. Automatic replay and “replay all matching query” are forbidden.

## Vendor Disable or Credential Incident

- Disable prevents unstarted attempts; an already sent request may finish and be recorded.
- Rotate credential by appending an endpoint version; never edit historical versions.
- Revoke affected API keys and issue a new key; do not log the replacement secret. (For a pepper compromise rather
  than a per-key incident, see [API-Key Pepper Rotation and Compromise](#api-key-pepper-rotation-and-compromise)
  below.)
- Verify audit and receipt convergence, then inspect new Delivery snapshots.

## API-Key Pepper Rotation and Compromise

通用生产 key-admin 接入不暴露为 HTTP API/CLI；部署方通过受控 harness 调用既有 KeyAdmin。唯一例外是
一次性的非 HTTP `bootstrap-openslack` 部署命令，它只能创建固定的 OpenSlack caller/auditor，不能执行
通用 issue/rotate/revoke。仓库中的测试专用 rotation 演练命令为：

```bash
go test ./tests/integration -run '^TestPepperRotationRunbookUsesKeyAdminAndFailsClosed$' -count=1 -v
```

### OpenSlack identity bootstrap

IB1 验收只使用两个唯一 fixture vendor ID。IB4 D4-0 对两个真实、仍为 draft 的 Canary vendor 执行同一
一次性 bootstrap；先预创建受保护输出目录，设置 `DATABASE_URL` 与 `API_KEY_PEPPER_ACTIVE`，然后运行：

```bash
go run ./cmd/bootstrap-openslack \
  --output /secure/operator-handoff/openslack-keys.json \
  --vendor-id "$CANARY_VENDOR_SLACK" \
  --vendor-id "$CANARY_VENDOR_WEBHOOK"
```

命令拒绝已有输出文件、重复 vendor、已有任一固定 principal，并且绝不向 stdout/stderr 输出 raw key。
成功时文件包含 caller/auditor 两把一次性 raw key，权限为 `0600`。将文件通过批准的 secret handoff
导入后保持受控保存；IB5 报告封存后的撤销属于后续 gate，不由本命令执行。

若命令报告 `commit_outcome_unknown`，或进程在文件 fsync 后退出，不得删除、覆盖或重新运行。使用文件中
非秘密的两个 `key_id` 与固定 principal ID 查询 `principals`/`access_keys`：四行全部存在且 kind、scope、
capability、pepper ID 与 verifier 均匹配时，保留该文件并把 bootstrap 视为已收敛；四行全部不存在时，
经人工记录后安全删除文件、fsync 父目录并重新运行；任意部分存在或字段冲突时隔离文件并升级处理。
已确认 rollback 的命令会自行删除并同步输出文件。

- **Routine rotation** (planned): deploy `API_KEY_PEPPER_ACTIVE=new` with `API_KEY_PEPPER_PREVIOUS=old`, restart,
  rotate principal keys at leisure under the at-most-two-active-keys rule, confirm zero non-revoked keys still
  reference `previous` via a count query, then drop `previous`. Draining `previous` is a precondition for the next
  routine rotation.
- **Emergency rotation** (suspected pepper compromise): (1) freeze `manage_access_keys` (no issue/rotate); (2)
  bulk-revoke every key whose `pepper_id` is the compromised generation in one Store transaction — at commit, the
  next authentication of a revoked key returns `401` immediately (zero-staleness; auth reads DB status, not the
  pepper); if the commit outcome is unknown, re-query the non-revoked count with that `pepper_id` to converge; (3)
  deploy the new pepper as `active` with **no** `previous` retained and restart so the burned pepper leaves memory;
  (4) re-issue keys, then unfreeze.
- **Pepper loss**: startup is fail-closed (readiness false, authentication `503`). Restore the pepper from its
  separate backup (independent of the database backup); if both primary and backup are unrecoverable, generate a new
  pepper and treat it as compromise-equivalent (full re-issuance).
- **Evidence** (per [Escalation and Evidence](#escalation-and-evidence)): capture the compromised `pepper_id` label
  (never the value), the count and `key_id`s of revoked keys, the operator `principal_id`, timestamp, Store
  transaction id and deploy version. The pepper **value** is never captured (CTRL-016). Closure must state whether any
  key issued under the burned `pepper_id` survived into the restart window (only possible if the freeze was violated).

## Database Failure

- Intake returns retryable service-unavailable; never return `202` before commit.
- Workers stop claiming; existing leases recover after the database and service are healthy.
- Confirmed rollback and commit-outcome-unknown are diagnosed differently.
- Do not start an empty replacement database or write to local disk as a fallback.

## OpenSlack vendor configuration v2

Parameter-only registration templates live in [`../../deploy/vendor-examples/`](../../deploy/vendor-examples/).
Render them outside the repository with deployment-owned values, validate the resulting admin command against the
OpenAPI document, and register the vendor as `draft`. Do not activate it during IB1. If a rendered fixture is no longer
needed, disable it through the ordinary governed admin command; do not delete endpoint history.

Before activation in a later gate, verify that Slack is schema v2 + `json_ack_v1` + bearer + mapping `none`, and that
Webhook is schema v2 + `http_status_v1` + `auth:none` + the two ingress-key headers. The list/history response must show
`response_policy`; Webhook must omit `credential_descriptor`. Reject and investigate any v2-to-v1 update, auth-none
credential descriptor, body-field mapping, or rotation request against an auth-none version.

IB4/IB5 单主机部署使用
[`../../deploy/canary/README.md`](../../deploy/canary/README.md) 中的
common + mode-specific Compose pack。真实 secret 只能从 `notification-canary`
protected environment 写入主机 owner-only mode-`0600` env file；必须先运行
`deploy/canary/preflight.sh`，且只允许其 stable code-only 输出进入 evidence。
真实 G4/G5 只接受 digest-pinned service/receiver image；service image digest
必须等于 deployment digest。`verified-local-build` 会绑定 clean commit/tree
和 deterministic rehearsal digest，但只能用于 G4 前预演。

Canary Compose 不发布 database port，app、Prometheus 和 receiver 只绑定
host loopback。deployment-owned reverse proxy 是唯一 external listener，只能
在 TLS/443 暴露 service/receiver origin，必须使用受信 CA certificate、关闭
redirect 和 request/body access log。开始 G4 前从 OpenSlack host 验证 external
TLS chain/hostname 和 health endpoints，并负向确认 public 8080/8090 不可达。

Webhook receiver 只保存 request ID、两个 idempotency header、body
digest/size 和时间；查询必须用独立 audit token。任何 payload、raw vendor
response、caller/auditor key、database password 或 Slack token 出现在
receiver record、日志、rendered Compose output 或 evidence 都是 G4 blocker。

Operations reconciliation 以 receipt 中的 `notification_id` 查询 notification status 和 attempt history。
status 必须返回匹配的 `vendor_id`；snapshot 后的 outcome 必须返回实际 `config_version`，claim/recovery、
replay 和 snapshot 前失败则保持缺省。不得用 payload、credential descriptor 或 vendor response body
补充对账。本地 RC-IB4-R1 机械证据见
[`../testing/ib4-r1-local-report.json`](../testing/ib4-r1-local-report.json)；该报告明确不等价于真实
`G4-E2E` 或 `G5-CANARY`。

隔离的 crash-after-send、双 recovery 竞争、数据库停止/恢复和有界关闭演练命令为：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/faults.sh
```

本轮事实证据见 [`../testing/fault-drill-report.md`](../testing/fault-drill-report.md)。

## Backup and Restore Target Procedure

生产仍须把 backup/WAL storage、identity 与 app secret 分离。仓库提供隔离本地演练：

```bash
COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 \
  docker compose --env-file deploy/local.env.example up --build --detach --wait
RUN_DESTRUCTIVE_ACCEPTANCE=1 scripts/acceptance/pitr.sh
```

脚本只接受命名为 acceptance 的源容器，在 `/tmp` 和临时 volume 内运行 PostgreSQL 18.4 physical
base backup、WAL archive、固定 age v1.3.1 加密和 target-time restore，并自动清理恢复资源。生产程序：

1. use the PostgreSQL platform's encrypted base-backup plus continuous WAL/PITR facility; backup storage credentials
   are separate from application credentials;
2. select retention and recovery objectives during deployment review from measured business needs—this design does
   not invent an RPO/RTO;
3. restore first into an isolated database at the selected recovery point, using the same PostgreSQL major and a
   schema version supported by the application release;
4. verify database consistency, migration version, notification immutable fields, unique idempotency keys,
   monotonic notification versions/attempt sequences, endpoint version immutability and current vendor pointers;
5. reconcile the restored maximum attempt/audit sequence and identify notifications whose send result may have
   occurred after the recovery point; treat them as duplicate-risk cases, never silently mark them delivered;
6. rotate database/backup credentials, point a controlled service instance at the restored database, run readiness
   checks and a scoped read-only inspection before routing intake;
7. record recovery point, validation evidence, potential duplicate window and operator decision.

A restore drill must succeed before production readiness and recur on an operator-owned schedule. Exact platform
commands, retention and drill cadence belong to the later deployment package.

本轮隔离恢复的逐字段结果见 [`../testing/pitr-report.md`](../testing/pitr-report.md)。

## Redaction Verification

新增日志 sink、projection 或验收制品时，运行 fail-closed marker 扫描：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/marker-scan.sh
```

本轮结果见 [`../testing/marker-scan-report.md`](../testing/marker-scan-report.md)。marker 扫描只证明已枚举
surface 的本轮输出；不能替代新增 sink 的设计审查。

## Safe Manual Actions

Allowed: scoped query, preview, replay execute, key revoke/rotate, vendor disable/config version append.

Forbidden: direct state UPDATE, attempt/audit DELETE, lease clearing, payload/secret export, bypass HTTP calls or
manually marking delivered.

## Escalation and Evidence

Capture request/notification/vendor IDs, stable result/reason, timestamps, config version and deployment digest.
Never capture raw API keys, credential refs, payloads or response bodies. Incident closure must state whether duplicate
delivery was possible and whether a replay occurred.
