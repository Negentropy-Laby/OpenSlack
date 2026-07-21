# Delivery

> **Status**: Approved — B-01 actual-result deadline correction independently re-reviewed 2026-07-20
> **Module**: Delivery（Feature · Layer 1）
> **Source**: `product-concept.md`、`module-index.md`、T0 BL-02..BL-05
> **Scope budget**: ≤400 lines / ≤25 acceptance criteria
> **Last Updated**: 2026-07-20

## Overview

Delivery 协调从 Notification Store 认领通知、从 Vendor Registry 获取每次 attempt 的权威最新配置、
安全构造并执行一次 HTTP(S) 请求，再把规范化结果写回 Store。它拥有重试/终止策略和 SSRF 运行时
防护，但不拥有通知状态、vendor 配置、凭证持久化、独立队列、DLQ 或 attempt ledger。

## User Promise

对每条已持久化且可投递的通知，Delivery 仅按已批准端点配置原样执行 HTTP(S) 投递，并通过有界
重试将结果推进到 `delivered` 或 `dead`。投递语义始终为 at-least-once；本模块不承诺
exactly-once，不解析或转换业务 payload，也不依据响应体做业务分支。

## Detailed Design

### Core Specification

可信 composition 从同一个已认证内部 Delivery service principal 构造两个**不可互换**的短生命周期
输入：Store 的
`StoreWorkerContext={kind=worker,actor_id,vendor_scope,capabilities={claim_delivery,record_delivery_result}}`
以及 `VRContextFactory`。后者只能在 claim 返回 `vendor_id` 后构造
`VRDeliveryContext={kind=delivery,actor_id,scope={kind=vendor_ids,vendor_ids={claimed.vendor_id}},
capabilities={vendor:snapshot-latest,vendor:read-credential-locator}}`。禁止把 Store context 转型为
VR context，禁止建立两套能力的 union / super context。

一次 `run_once(store_worker_context, vr_context_factory)` 固定执行：

1. 调 Store `claim(lease_ttl,store_worker_context)`；empty 时结束。Store 对 eligible work 按 cycle
   age 排序。
2. 计算 `cycle_deadline=delivery_cycle_started_at+MAX_AGE` 与
   `cycle_send_cutoff=cycle_deadline-HTTP_HARD_TIMEOUT-RESULT_COMMIT_MARGIN`，再判定上限：
   - `now >= cycle_send_cutoff` → `die(policy_termination,deadline_exceeded)`；
   - 否则 `attempt_count >= 25` → `die(policy_termination,attempt_limit)`。
3. 由 factory 为 claimed vendor 构造 singleton-scope `VRDeliveryContext`；每个未开始 attempt 调 VR
   `snapshot(vendor_id,{latest_active},vr_delivery_context)`，不按 delivery cycle 固定版本。
4. 按 snapshot 解析最小权限 credential，并装配候选 Header/body；body-field 映射后的最终 body
   才参与 budget 校验。credential 只存在于当前 AttemptContext。
5. 对候选目标解析全部 A/AAAA 结果并执行地址策略。任一解析地址不合法即整次 fail-closed；
   已解析 credential 立即丢弃且不得记录；socket 只连接已验证
   pinned IP，同时保留原 hostname 的 SNI/证书校验；禁用隐式代理和所有自动 redirect。
6. preflight 结束时重新检查 cycle 与 lease：
   - `now >= cycle_send_cutoff`：不发 HTTP，提交无计数 `deadline_exceeded`；
   - 否则必须在 `lease_expires_at-HTTP_HARD_TIMEOUT-RESULT_COMMIT_MARGIN` 前完成；超过该 lease
     send cutoff 不发 HTTP，提交 retryable `transport_failure(error_code=preflight_timeout)`。
7. 在 `HTTP_HARD_TIMEOUT` 内发送一次请求；只读 status 与合法 `Retry-After`，不读取响应体。
8. 分类并调用 Store canonical `transition_request(succeed|retry|die)`。若已产生的 HTTP/transport
   结果原本可重试，但分类时 `now >= cycle_send_cutoff`，不得先写 `retry` 再等待第二次 claim；
   必须在本次写回中改为 actual-result
   `die(outcome_class=permanent_failure,reason=deadline_exceeded)`。

**一次计数 attempt** 包含可能到达外部系统的出站准备/传输阶段。DNS、secret provider、连接和超时的
瞬态失败使用 `transport_failure` 并计一次；下列确定性未发送终止使用
`policy_termination` 且不增加计数：

| Pre-send reason | Condition |
|---|---|
| `vendor_unavailable` | latest snapshot inactive/unknown/out-of-scope |
| `destination_rejected` | SSRF/地址/端口/例外策略拒绝 |
| `credential_unavailable` | credential 配置缺失、无效或永久不可解析 |
| `request_unbuildable` | malformed snapshot、VR `INVALID_COMMAND`、body 超限、幂等 mapping 不适用/字段冲突、请求策略矛盾 |

### HTTP Outcome Matrix

| Result | Store delivery result / transition | Attempt count |
|---|---|---:|
| `2xx` | `http_response, success, http_status` / `succeed` | +1 |
| `408` / `429` / `5xx` | `http_response, retryable_failure, http_status, next_attempt_at` / `retry` | +1 |
| DNS（含 no-answer/NXDOMAIN）/ secret provider transient / connect / TLS / timeout / VR authority unavailable | `transport_failure, retryable_failure, stable error_code, next_attempt_at` / `retry` | +1 |
| 上述 retryable HTTP/transport 结果在分类时已到 `cycle_send_cutoff` | 保留 `http_status`/`error_code`，改为 `permanent_failure, reason=deadline_exceeded` / actual-result `die` | +1 |
| `1xx` / `3xx`（不跟随）/ other `4xx` | `http_response, permanent_failure, http_status, reason=non_retryable_http_status` / `die` | +1 |
| deterministic pre-send reason | `policy_termination, permanent_failure, reason` / `die` | unchanged |

VR 的 inactive/unknown/out-of-scope 合并结果是 `vendor_unavailable`；malformed active snapshot 是
`request_unbuildable`；VR `FORBIDDEN` / invalid actor / authority infrastructure failure 不伪装为 vendor
状态，按 retryable `transport_failure(error_code=registry_access_failure)` 处理并发出 worker health
事件。VR `INVALID_COMMAND` 表示 Delivery 构造了确定性非法的固定 snapshot 命令，映射为无计数
`policy_termination(request_unbuildable)` 并发出 worker health event，不重试、不访问 credential 或
网络。DNS 只有地址策略命中才是 `destination_rejected`，解析失败本身保持 retryable。

每次 Store 写回均携带 claim 的 `expected_state=in_flight`、`expected_version`、`lease_id` 与最小
worker ActorContext；variant-specific 字段严格引用 Store 判别联合。Store 拒绝后不得本地旁路写入。

`Retry-After` 不改变分类。full-jitter：

`jitter = uniform(0, min(RETRY_DELAY_CAP, RETRY_BASE_DELAY × 2^attempt_count))`

若 `Retry-After` 是合法 delta/date，先计算
`effective_retry_after_delay=min(max(0,retry_after_at-now), RETRY_AFTER_CAP)`，再令
`candidate_delay=max(jitter,effective_retry_after_delay)`；
若分类时 `now < cycle_send_cutoff`，则
`next_attempt_at=min(cycle_send_cutoff,now+candidate_delay)`；当 cycle 可发送时间小于有效下限时，
cutoff 优先，非法、过期、负值或溢出时忽略并使用 jitter。若分类时已
`now >= cycle_send_cutoff`，本次 actual result 直接以 `deadline_exceeded` 原子终止并计数，
不产生 `next_attempt_at`。尚未发送而在 cutoff 后被 claim 的行仍走无计数 policy termination。

Delivery 必须保留两条 deadline finalization 路径：尚未开始 attempt 的 eligible 行须在
`DEADLINE_CLAIM_BUDGET` 内被 claim 并以无计数 policy termination 终止；已开始 attempt 则由
`cycle_send_cutoff` 预留 `HTTP_HARD_TIMEOUT + RESULT_COMMIT_MARGIN`，其 retryable result 若在 cutoff
后完成，直接在当前结果写回中 actual-result `die`。Store 与 Delivery 健康且硬超时/提交余量成立时，
两条路径都在 24h deadline 前写入 `dead`。内部服务不可用时发 worker health signal，不伪报达标。
具体 worker 拓扑由 Architecture 决定；本契约不新增队列、retry state 或 deadline ledger。

### States and Transitions

Delivery 不持久化状态。单次执行的短生命周期阶段是：

| Phase | Exit |
|---|---|
| `claimed` | policy termination 或 `snapshotting` |
| `snapshotting` | policy/transport failure 或 `preflight` |
| `preflight` | policy/transport failure 或 `sending` |
| `sending` | HTTP/transport outcome |
| `reporting` | Store accepted / rejected result |
| `done` | 不再操作该 lease |

Store 拒绝 stale/invalid/expired lease 后，Delivery 不重交结果、不伪造 attempt；等待 Store recovery
记录 `unknown_result`。无 lease renewal。

### Interactions with Other Modules

| Module | Consumed contract | Ownership boundary |
|---|---|---|
| Notification Store | `claim`、`transition_request`、payload/vendor/cycle metadata；typed Store worker context | Store owns state, lease, attempt history and cycle-age claim order |
| Vendor Registry | per-attempt `snapshot({latest_active})`；typed singleton-scope VR delivery context | VR owns active/latest config and credential reference |
| secret provider | resolve opaque credential reference | provider owns secret; Delivery only uses it in memory |
| Caller Access / Operations / Observability | none | no direct runtime dependency |

Vendor disable/update/rotate 在 snapshot 前提交时必须被当前 attempt 看到。HTTP 已发出后 vendor 被
disable，当前请求允许完成并记录结果；下一个 attempt 再读取 latest。

## Data Model

**无持久领域实体。** 短生命周期
`AttemptContext={notification_id,lease_id,version,vendor_id,payload,attempt_count,cycle_started_at,
config_version,resolved_ip,request_started_at}` 仅存内存并在 `done` 后丢弃。

Delivery 不保存 payload 副本、raw response、secret、retry table、queue、DLQ 或 config snapshot。
日志只允许稳定 ID、config version、去敏 outcome/reason 与耗时。

## Edge Cases

- **If deadline 与 attempt limit 同时命中**：`deadline_exceeded` 优先。
- **If latest snapshot 返回 inactive/unknown/out-of-scope 合并负向**：`vendor_unavailable`，
  不解析凭证、不建 socket。
- **If VR authority 读取失败/拒绝 VR delivery context**：`registry_access_failure` retry，不伪装为
  inactive/unknown；`INVALID_COMMAND` 或 malformed active snapshot 是 `request_unbuildable`。
- **If 任一 A/AAAA 地址被禁止**：整次 `destination_rejected`，不选择“安全的那一个”继续。
- **If DNS 在校验后 rebinding**：连接仍只使用 pinned IP，禁止二次解析。
- **If vendor 返回 3xx**：记录永久 HTTP 失败，不发第二个请求。
- **If body-field mapping 的 payload 非 JSON object 或字段已存在**：`request_unbuildable`，不覆盖。
- **If idempotency header 与配置 Header 冲突**：`request_unbuildable`，不覆盖。
- **If transient failure 的 next time 达到 cycle send cutoff**：将 `next_attempt_at` 压到 cutoff；
  下次 claim 无计数终止。
- **If cutoff 前开始的 attempt 在 cutoff 后返回 retryable result**：保留实际 status/error，当前
  写回直接 actual-result `die(deadline_exceeded)`，计数 +1；禁止先 `retry` 或等待第二次 claim。
- **If preflight 越过 cycle cutoff**：不开始 HTTP，提交 `deadline_exceeded`；仅越过 lease cutoff
  且 cycle 仍有预算时才提交 `preflight_timeout` retry。
- **If Store/Delivery 内部不可用导致 finalizer 超出预算**：发 worker health signal，保留真实
  pending/in-flight 状态，不发布虚假 deadline 达成声明。
- **If HTTP 已发送后进程崩溃**：Store lease recovery 记录 unknown result；后续可能重复投递。
- **If Store 拒绝结果提交**：停止处理该 lease，不能把外部结果写入本地旁路存储。

## Dependencies

- **硬依赖**：Notification Store、Vendor Registry、运行时 DNS/TLS/HTTP 与 secret provider。
- Store 与 VR CDD 是权威契约；Delivery 不改变二者的状态/配置所有权。
- Approval gate：VR J1–J3 / independent re-review #5 完成，且 Store preflight compatibility
  focused review 通过。

## Configuration

| Key | Default | Range / invariant |
|---|---:|---|
| `MAX_ATTEMPTS` | `25` | T0 固定上限 |
| `MAX_AGE` | `24h` | T0 固定上限 |
| `RETRY_BASE_DELAY` | `1s` | `>0` |
| `RETRY_DELAY_CAP` | `1h` | `>=base` 且 `<MAX_AGE` |
| `RETRY_AFTER_CAP` | `1h` | `>0` 且 `<=MAX_AGE` |
| `HTTP_HARD_TIMEOUT` | `10s` | `1s..30s` |
| `RESULT_COMMIT_MARGIN` | `5s` | `>0` |
| `DEADLINE_CLAIM_BUDGET` | `5s` | `>0` 且 `<HTTP_HARD_TIMEOUT+RESULT_COMMIT_MARGIN` |
| `LEASE_TTL` | `30s` | 必须覆盖所有 preflight timeout + HTTP timeout + commit margin |
| runtime destination blocklist | platform baseline | IPv4/IPv6 全非公网默认拒绝 |

任何不满足不变量的配置使 worker 启动失败。具体 HTTP client、DNS resolver、CIDR 清单、时钟、
随机数、secret provider、并发数和调度机制属于 Architecture。

## Integration Requirements

- Store `claim` 返回 `{notification_id,lease_id,lease_expires_at,version,payload,vendor_id,
  attempt_count,delivery_cycle_started_at,created_at}`；扫描式 claim 只在 eligible 行中按
  `(delivery_cycle_started_at,created_at,notification_id)` 升序选择。
- Store 与 VR 分别接收上述最小 typed context；二者都由可信 composition 从已认证内部 service
  principal 构造，VR scope 必须在 claim 后收窄为当前单一 vendor，任一 context 都不能携带另一模块能力。
- VR latest snapshot 必须同时通过 `vendor:snapshot-latest` 与
  `vendor:read-credential-locator` capability，并返回闭合 `DeliveryConfigSnapshot`。
- 幂等映射：
  - `none`：不注入，原 payload bytes 不变；
  - `header`：在配置指定且未冲突的 Header 写入规范化 `notification_id`，body bytes 不变；
  - `body_field`：仅在 JSON Content-Type + JSON object 下，向未占用 top-level flat key 写入同一
    `notification_id`；除新增该成员外，原成员和值语义不变，最终编码 body 再校验大小。
- 上述 body-field 是“不转换业务 payload”的唯一受控例外；字段冲突、类型/Content-Type 不适用、
  header 冲突或最终 body 超限均 `request_unbuildable`，禁止覆盖或静默跳过。
- 相同 notification 跨 retry/replay 使用同一规范化 `notification_id` 值；供应商不支持时重复副作用
  仍是公开风险。
- 出站 URL、method、Content-Type、静态/认证 Header 只能来自 snapshot；调用方不能指定。
- Store preflight focused revision 必须接受六项闭合 `policy_termination` reason，禁止
  `http_status/error_code/next_attempt_at`，且 `attempt_count` 不变。

## UI Requirements

**N/A — background headless worker.**

## Acceptance Criteria

- **DL-01 [Integration]**：**GIVEN**合法 claim 与 active latest snapshot，**WHEN** vendor 返回 2xx，**THEN**携带 claim 的 lease/version/context 恰一次提交合法 `succeed`，Store attempt count +1。
- **DL-02 [Logic]**：**GIVEN** Store/Delivery 健康，**WHEN**尚未发送的 eligible 行在 cutoff 后被认领，或 cutoff 前开始的 retryable attempt 在 cutoff 后完成，**THEN**前者无计数 policy termination，后者保留实际结果并计数 +1；两者均以当前 Store 写回 `deadline_exceeded`、禁止 `next_attempt_at`，并在 24h deadline 前进入 dead。
- **DL-03 [Logic]**：**GIVEN**未到 deadline 且 attempt_count≥25，**WHEN** claim，**THEN**提交 `attempt_limit`，不发 HTTP，计数不变。
- **DL-04 [Integration]**：**GIVEN**每个未开始 attempt，**WHEN**进入发送流程，**THEN**都读取一次 latest snapshot；update/rotate/disable 立即反映。
- **DL-05 [Integration]**：**GIVEN**HTTP 已发出后 vendor disable，**WHEN**请求完成，**THEN**允许提交该 HTTP 结果；下次 attempt 再被阻止。
- **DL-06 [Logic]**：**GIVEN**四类确定性 pre-send 失败，**WHEN**分类，**THEN**使用对应闭合 reason，未发网且 attempt count 不变。
- **DL-07 [Integration]**：**GIVEN**408/429/5xx 或瞬态 DNS/connect/TLS/timeout/internal-authority failure，**WHEN**在 cutoff 前分类，**THEN**提交含稳定字段的 retry、attempt count +1；若分类时已到 cutoff，则保留稳定字段并 actual-result `die(deadline_exceeded)`、attempt count +1。
- **DL-08 [Logic]**：**GIVEN**合法 Retry-After，**WHEN**在 cutoff 前计算 next time，**THEN**有效下限截断为 1h 并与 jitter 取大值、结果截断到 `cycle_send_cutoff`；非法值回退 jitter；分类时已到 cutoff 则不生成 next time，当前 actual result 原子终止。
- **DL-09 [API Contract]**：**GIVEN**1xx、3xx 或其他 4xx，**WHEN**处理，**THEN**提交含 status 与 `non_retryable_http_status` 的永久失败；3xx 不产生第二个请求。
- **DL-10 [Security Negative]**：**GIVEN**A/AAAA 任一结果禁止或例外不匹配，**WHEN**preflight，**THEN**已解析 credential 立即丢弃、不建 socket，提交 `destination_rejected`。
- **DL-11 [Security Negative]**：**GIVEN**DNS 校验后 rebinding，**WHEN**连接，**THEN**只连接 pinned IP，并保持原 hostname TLS 验证。
- **DL-12 [API Contract]**：**GIVEN**body/header mapping 不适用、冲突或最终 body 超限，**WHEN**构造请求，**THEN**提交 `request_unbuildable`，不覆盖、不静默跳过。
- **DL-13 [Security Negative]**：**GIVEN**任一结果，**WHEN**检查 Delivery 自有持久化、attempt/result、日志与指标，**THEN**不复制或泄露 secret、credential locator、payload 或 response body；Store Notification 的权威 payload 不受此断言影响。
- **DL-14 [Concurrency]**：**GIVEN**多个 worker 竞争同一通知，**WHEN**claim，**THEN**至多一个有效 lease holder 发 HTTP。
- **DL-15 [Integration]**：**GIVEN**HTTP 可能已发送但 lease 过期，**WHEN**旧 worker 提交，**THEN**Store 拒绝；recovery 记录 unknown result，允许至少一次重试。
- **DL-16 [API Contract]**：**GIVEN**静态依赖审查，**WHEN**检查持久化与生产者，**THEN**无独立 queue、DLQ、retry table、config snapshot 或 attempt ledger。
- **DL-17 [Integration]**：**GIVEN**none/header/body-field 三种映射，**WHEN**同一 notification 经 retry 或 replay，**THEN**成功路径使用同一规范化 notification_id；none/header 保持 body bytes，body-field 只新增一个未占用成员。
- **DL-18 [API Contract]**：**GIVEN**一次 run，**WHEN**claim、snapshot 与结果写回，**THEN**Store 调用只携带 worker typed context，VR 调用只携带 singleton-vendor delivery typed context，二者不可互换；写回仍包含 expected state/version、lease 及 Store 判别联合允许字段。
- **DL-19 [Logic]**：**GIVEN**preflight 越过时间预算，**WHEN**重检，**THEN**越过 cycle cutoff 时无计数 `deadline_exceeded`，仅越过 lease cutoff且 cycle 尚有预算时才提交 `preflight_timeout` retry，两者均不发 HTTP并保留结果提交余量。
- **DL-20 [Logic]**：**GIVEN**VR/DNS/HTTP 任一闭合结果，**WHEN**分类，**THEN**恰落入结果矩阵一行；VR 负向不泄露 inactive/unknown/out-of-scope 区别，VR `INVALID_COMMAND` 唯一映射为无计数 `request_unbuildable` + worker health event。

### C1–C15 Applicability

| ID | Disposition | Locus |
|---|---|---|
| C1 | Applied | fixed flow + total outcome matrix |
| C2 | Applied | Store write / health-event boundary |
| C3 | Applied | AttemptContext and active discard rules |
| C4 | Applied | jitter/Retry-After formula |
| C5 | Applied | claim/policy/preflight/send gates |
| C6 | Applied | merged VR negative result |
| C7 | Applied | lease/OCC loser behavior |
| C8 | Applied | HTTP unknown via Store recovery |
| C9 | Applied | worker/system ownership |
| C10 | Applied | Store/worker authoritative time |
| C11 | Applied | VR and Store capability contracts |
| C12 | N/A | no collection query |
| C13 | Applied | AttemptContext field ownership |
| C14 | Applied | worker vendor scope |
| C15 | N/A | no collection query |

## Open Questions

无未决行为问题。B-01 已由所有者裁决：cutoff 前启动、cutoff 后才得到的 retryable actual result
在当前写回原子 `die(deadline_exceeded)`，不再产生第二次 claim。该修订及配套 Store 判别联合已通过
fresh independent focused review。URL/IDNA/CIDR 算法、HTTP/DNS/TLS 库、secret provider、时钟与
worker 拓扑由已建立的 Architecture/ADR 文档约束，具体代码仍待实现授权。
