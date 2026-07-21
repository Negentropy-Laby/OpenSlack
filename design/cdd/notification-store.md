# Notification Store

> **Status**: Approved — B-01 actual-result deadline extension independently re-reviewed 2026-07-20
> **Source Concept**: `design/cdd/product-concept.md`
> **Module**: Notification Store（Foundation · Layer 0）
> **Method**: `/design-system notification-store --review lean` → bounded correction pass 2026-07-18（独立评审前；rc_wsman 未安装 CDD）
> **Review Mode**: lean（per-run；repo 级 `review-mode.txt` 未建；`CD-GDD-ALIGN` director gate 按 Lean 跳过并记录——仅跳过非 phase director gate，不代表 CDD 获批）
> **Created**: 2026-07-18

## Overview

> Notification Store 是 rc_wsman 的持久状态与事务边界：接收由受信任 ingress composition 构造的内部 `ValidatedIntake` 命令，在一个原子事务内持久化不可变的请求身份（`request_fingerprint`）与原样业务 payload，并暴露"可投递"的 outbox 视图。它是 transactional outbox 模式的单一真相源（BL-03）——接收与可投递可见性一次提交或一次失败，禁止库外队列双写。本模块独占通知的状态机、尝试历史（`append_attempt`）、并发认领（单有效 lease）契约与 delivery cycle 元数据，并承载入站幂等去重与 `request_fingerprint` 冲突（`409 IdempotencyConflict`，BL-02）。
>
> 本模块**只持久化与保护状态**：不做出站 HTTP、不拥有重试策略（`MAX_ATTEMPTS`/`MAX_AGE`/full-jitter / deadline 判定归 Delivery）、不解析或改写业务 payload、不查询供应商配置（归 Vendor Registry）、不认证调用方（归 Caller Access）。在已批准的 Option A 接缝下，Store 只接收服务端内部构造的 `ValidatedIntake`（opaque `caller_id` + 已授权、已确认 active 的 `vendor_id` + `payload` + `idempotency_key`），不自行校验来源；调用方在外部 HTTP 请求中提交的 `vendor_id` 由 ingress composition（Caller Access + Vendor Registry）校验后映射为内部 `vendor_id`。出站 `Content-Type` 属于受控端点的传输 Header，由 Vendor Registry / Delivery 决定，不进入 Store 状态。Store 暴露 delivery cycle 元数据（`attempt_count`、`delivery_cycle_started_at`、`created_at`），使 Delivery 能在发出 HTTP 前根据已批准策略决定 `retry`/`die`。Delivery / Operations Control / Reliability Observability 均已 Approved，以下跨模块契约现为 binding。

## User Promise

**对调用方（内部业务系统）与操作员的双重契约：**

> 一旦 Store 返回 `202`，该通知即在同一原子事务内被持久化并可见为"可投递"。
> 重复提交（相同 `(caller_id, Idempotency-Key)`）：`request_fingerprint` 一致时返回同一
> `notification_id`（`202`），不一致时返回 `409 IdempotencyConflict` 且不新增状态。

> Store 是每条通知生命周期的权威记录——`pending` / `in_flight` / `delivered` / `dead`——
> 以 append-only 方式记录全部尝试历史，且任一时刻最多只有一个有效 lease 持有者。
> 操作员可查询 outbox 深度、最老 pending 年龄、dead 计数（BL-06），并对 dead 通知执行
> 受守护的人工重放而无需重新提交。

**边界（本承诺不包含）：** 本承诺是"持久接收 + 权威、可恢复、并发安全的状态"。它**不承诺**
供应商一定收到通知——最终送达是 Delivery 的职责；Store 只保证把可投递状态与命令契约交给
Delivery，并忠实记录其回报的结果。

## Detailed Design

> 行为契约（describe what it does, not how it's built）。子节：Core Specification /
> States and Transitions / Interactions with Other Modules / Logical Responsibilities。
> 栈相关实现（SQL/DDL/ORM/连接池/迁移）记为 Architecture / ADR deferred。

### Core Specification

> 行为契约。栈相关实现（SQL/DDL/ORM/锁机制/连接池/迁移）记为 Architecture / ADR deferred。

**A. 接收（Intake）**

> Store 内部接收面只处理 `ValidatedIntake`；外部 HTTP envelope 的校验由 ingress composition 负责。

**外部 intake precondition（不属于 Store）**：外部 HTTP envelope 的 `Content-Type` 必须为
`application/json`，必填 `vendor_id` + base64 字符串 `payload_base64`；`Idempotency-Key` 为 Header。
ingress composition 严格解码 `payload_base64` 为原始 vendor payload 字节后才构造内部 `payload`；外部 envelope
中不得出现 `caller_id`、`is_verified`、URL 或 `SCHEMA_FIELDS` 未列字段；出现则由 ingress
composition 拒绝，**Store 不处理该请求、不返回外部 HTTP 状态码**。这里的 Content-Type 只描述
入站 envelope；供应商出站 Content-Type 由端点配置决定。

**Store 内部接收**：`vendor_id` 由调用方提交后，经 Caller Access（key→vendor scope）和 Vendor Registry
（existence / active）校验；ingress composition 构造内部 `ValidatedIntake`：
`{caller_id, vendor_id, payload, idempotency_key}`。Store 只接收 `ValidatedIntake`，
不查询 Caller Access / Vendor Registry，也不接受调用方自报的 `caller_id`/`is_verified`。

- `request_fingerprint` 由 Store 从内部 `ValidatedIntake` 的规范化形式计算（调用方不提供）。指纹字段集
  最小为规范化 vendor payload 字节 + `vendor_id`；完整规范化算法 deferred 到幂等 ADR，但"服务端
  计算、持久化后不可变、按稳定字节比较"是 CDD 行为约束。
- 闭合 envelope 结构校验：**Store 只校验内部 `ValidatedIntake` 的字段存在、类型、大小、编码与
  `idempotency_key` 格式**；`PAYLOAD_MAX_BYTES` 作用于规范化后的 vendor payload 字节，不是整个
  HTTP envelope。Store 不做 payload 语义校验、供应商能力匹配或业务规则校验。
- 强去重：复合键 `(caller_id, Idempotency-Key)` 唯一约束；`Idempotency-Key` 对所有 intake 必填。
- 接收判定矩阵：无既有行 → 插入（`pending`）+ `notification_id` + `202`；同键同指纹 → 既有
  `notification_id` + `202`，**不改状态、不新增 attempt 行**；同键异指纹 → `409
  IdempotencyConflict`，**不新增任何持久状态**。
- intake 后不可变量：`request_fingerprint`、`(caller_id, Idempotency-Key)`、`vendor_id`、
  payload、`created_at`。后续同键提交不同 `vendor_id` 为 `409`。

**B. 原子性（Atomicity · BL-03）**
- intake 提交单一原子单元：notification 行（`pending` + 指纹 + 去重键 + payload + 不可变
  `vendor_id` + `created_at`）与"可投递可见性"**一起提交或一起失败**。
- "可见性"是行为属性：提交后任何 Delivery `claim` 可观察该通知；提交前任何 Delivery 调用都
  观察不到。物理机制（状态列 / 部分索引 / 独立可认领行族）为 Architecture deferred。
- intake 路径**不**向任何外部系统发布，**不**调用 Vendor Registry / Caller Access 或任何进程外
  服务。仅在提交成功后返回 `202`。**确定回滚**时返回可重试错误、无行且无 id；同键重试按新
  intake 创建（除非另一个并发请求已成功）。**提交结果未知**（例如 commit 后连接中断）时返回
  `commit-outcome-unknown`、无 id；同键重试由唯一约束与去重矩阵决定为“返回已提交的既有 id”
  或“创建一次新通知”，不得产生重复行。
- 并发接收竞态由唯一约束仲裁：败方**不得**盲返 5xx，必须重读并应用去重矩阵。

**C. 并发认领（Concurrent Claim）**
- `claim(filter?, lease_ttl, actor_context)`：Delivery worker 请求下一可认领通知（可选 `vendor_id` 过滤）
  或认领指定 `notification_id`。`lease_ttl` **由 Delivery 每次 claim 提供**；Store 只校验
  `lease_ttl > 0` 且不超过 Architecture 定义的绝对防失控上限，不拥有具体值，也不接收 Delivery 的
  HTTP timeout / margin 来重建跨配置关系。
- **可认领资格**：`state=pending AND (next_attempt_at IS NULL OR next_attempt_at<=store_now)`，并满足
  ActorContext scope / filter。扫描式 claim 跳过尚未到期或已被并发锁定的行，继续寻找下一条；
  无可认领行返回 `empty`。指定 `notification_id` 已授权但尚不可认领或被并发占用时也返回
  `empty`，不返回 `conflict`。
- **扫描顺序**：扫描式 claim 对 eligible 行按
  `(delivery_cycle_started_at ASC, created_at ASC, notification_id ASC)` 稳定选择。replay 重置
  `delivery_cycle_started_at` 后，该通知按新 cycle 年龄参与排序，不得因历史 `created_at` 更早而
  抢占更接近 24 小时上限的旧 cycle。该顺序只决定“下一条”候选，不改变资格、状态机或 lease 语义。
- 认领后：notification → `in_flight`；恰有一个**有效** lease `(lease_id, lease_expires_at,
  lease_holder)`；`lease_id` 由 Store 生成，`lease_holder` 从已验证的
  `actor_context.actor_id` 推导，二者均不可由调用方自报。有效 lease 时刻 t 的定义：
  `lease_id` 匹配当前行 **且** `lease_expires_at > t`。
- 并发竞态：两个 worker 争同一通知——恰一个获得 lease；另一个跳过（`SKIP LOCKED` 方向）。
- 重新认领竞态保护（核心安全属性）：lease 过期、worker B 重新认领后，原 worker A 用过期
  `lease_id` 上报结果 → transition-request 以 `expired-lease` 拒绝（见 States & Transitions）。

**D. 尝试原子性（Attempt Atomicity · NS-BR-02）**
- 改变状态**且**代表一次尝试结果的 transition-request，其 `append_attempt` 与：状态更新、
  version++、lease 清除、`attempt_count`（按 `delivery_result.result_kind` 更新）、
  `last_outcome_class` / `last_error_code`、
  `next_attempt_at`、`delivered_at`/`dead_at`/`dead_reason`/`replayed_at` **在同一原子单元**写入。
  replay 时 `attempt_count` 重置为 0，`delivery_cycle_started_at` 更新为 `replayed_at`，
  `replay_count++`，旧 dead/replay 事实保留在 append-only history。
- `attempt_count` 更新规则：`http_response` / `transport_failure` / `unknown_result` → `attempt_count++`；
  `policy_termination` → `attempt_count` 不变。`claim` / `replay` 不增加 `attempt_count`。
- 不变量：绝不"有 attempt 行但状态未变"/"状态已变但缺 attempt 行"/"`attempt_count` 与行不一致"。
- 完整时间线：claim 写一条 `claimed` 行；成功/可重试失败/永久失败/恢复/重放/发送前终止各写其行。
  `attempt_count` **只计**实际发生或不可知的投递尝试，不计 `claimed` / `policy_termination` / `replay`。
- 仅追加：attempt 行**永不更新、永不删除**；更正以引用旧行的新行表达。

**E. 租约恢复（Lease Recovery · NS-BR-03）**
- 触发：notification 处于 `in_flight` 且 `lease_expires_at ≤ store_now`。两种情形在决策时刻不可区分
  （HTTP 前崩溃 / HTTP 后结果未知崩溃）；`claimed` 行使其在审计中部分可辨。
- at-least-once 规则（BL-02 核心）：后者**必须**计为尝试并写审计——
  `append_attempt(outcome=unknown_result, actor=recovery_sweeper)`，`attempt_count++`（current-cycle），
  `last_outcome_class=retryable_failure`、`last_error_code=lease_expired_unknown_result`，
  `next_attempt_at` 默认 Store 权威事务时钟。**不得**
  伪装为未尝试。恢复尝试是 current-cycle 的一次尝试；是否因此转 `dead` 由 Delivery 根据 cycle 元数据
  在下次 claim 后、发送 HTTP 前决定，Store 的 recovery 本身不直接转 `dead`。
- 恢复转换 `in_flight → pending`：清 lease、version++，重新可被认领。暴露为显式操作
  `recover_expired_leases(batch_limit, actor_context)`；`actor_context.kind=system` 且须具备
  `recover_expired_leases` capability。`batch_limit` 必须为 `1..RECOVERY_BATCH_MAX`，否则
  `invalid-batch-limit`。**调用方不能提供时间**：Store 在事务内从自身权威、受健康监测的时钟域取得
  `store_now`，只恢复 `lease_expires_at<=store_now` 的行；测试只能通过受信任 test composition
  注入 clock，不能通过生产操作参数覆盖。若权威时钟不可用或被 clock-health guard 判为不可信，
  返回 `clock-unavailable`，整批零副作用；时钟健康检测机制与允许偏差由 Architecture 在实现前确定。
  触发模式（lazy/eager/hybrid）为部署决定。
- 禁止：绝不静默 `in_flight → pending` 不写 attempt 行；绝不删除/覆盖既有 lease；绝不当作不计数
  免费重试。sweeper 幂等由 transition-request 的 `stale-version`/`invalid-lease` 拒绝保证。

### States and Transitions

**状态集合**：`pending`、`in_flight`、`delivered`、`dead`。intake 初始态 `pending`；
`delivery_cycle_started_at` 初始为 `created_at`。

**合法转换**：

| From | To | 触发 | 前置条件 | 原子副作用 |
|---|---|---|---|---|
| `pending` | `in_flight` | `claim` | `kind=worker` + `claim_delivery` capability；scope 覆盖；通知可认领 | 设 lease；`append_attempt(claimed)`；version++ |
| `in_flight` | `delivered` | 成功结果 | `kind=worker` + `record_delivery_result` capability；有效 lease | 清 lease；`delivered_at`；`attempt_count++`；更新 last-result 字段；`append_attempt(success)`；version++ |
| `in_flight` | `pending` | 可重试失败 | `kind=worker` + `record_delivery_result` capability；有效 lease | 清 lease；`attempt_count++`；更新 last-result 字段；`next_attempt_at`；`append_attempt(retryable_failure)`；version++ |
| `in_flight` | `pending` | 租约恢复 | `kind=system` + `recover_expired_leases` capability；Store 权威时钟判定 lease 过期 | 清 lease；`attempt_count++`；`last_outcome_class=retryable_failure`；`last_error_code=lease_expired_unknown_result`；`next_attempt_at=store_now`；`append_attempt(unknown_result, recovery)`；version++ |
| `in_flight` | `dead` | Delivery 决定终止 | `kind=worker` + `record_delivery_result` capability；有效 lease；合法 `delivery_result` | 清 lease；`dead_at`/`dead_reason`；按 `delivery_result.result_kind` 更新 `attempt_count`；更新 last-result 字段；`append_attempt(event_kind=outcome, delivery_result)`；version++ |
| `dead` | `pending` | 人工重放 | operator ActorContext + `replay` capability + 合法 `justification` | `replayed_at=store_now`/`replay_actor`/`replay_reason`；`append_attempt(replay, operator)`；`attempt_count=0`；`delivery_cycle_started_at=replayed_at`；`replay_count++`；清除 `dead_at`/`dead_reason`；重置 `next_attempt_at=store_now`；version++ |

**终态**：`delivered` = 真终态，无出转换，重放被拒（`illegal-transition`）；`dead` = 可恢复终态，
仅授权人工重放可翻回 `pending`。

**非法路径（一律 `illegal-transition`）**：`delivered → *`；`pending → delivered`（须先 claim）；
`pending → dead`（无 poison path，#11）；`dead → in_flight`/`dead → delivered`（须经 `pending`）；
`pending → pending`（非转换；幂等 intake 重放不改状态）。

**关键竞态裁定**：
- **lease 过期 vs 成功上报**：HTTP 成功但在响应与 `record_attempt` 间 lease 过期 → `expired-lease`
  拒绝。**无续约操作**——worker 结果被拒，经恢复路径（`in_flight→pending`，
  unknown_result 计入 attempt）重试（at-least-once）。
- **重放重置**：`attempt_count=0`、`delivery_cycle_started_at=replayed_at`、`replay_count++`；
  旧 dead/replay 事实保留在 append-only history。
- **`next_attempt_at` 归属**：Delivery 持重试策略（BL-04），可重试失败时由 Delivery 设置；Store 持久化
  不计算；恢复路径用保守默认 `store_now`。

**ActorContext（栈中立信任输入）**

`ActorContext={kind∈{worker,operator,system}, actor_id, vendor_scope, capabilities}`。它由可信服务端
composition 提供，所有 claim / transition / query / recovery 操作必填；具体承载方式（in-process
context、JWT、mTLS 等）由 Architecture 决定。`actor_id` 来自全局唯一的服务端 principal namespace，
同一 id 的 `kind` 绑定不可由请求改变；Store 以此安全地从 `actor_id` 推导 `lease_holder`。Store 校验
kind、scope 与 capability，不接受外部调用方在业务请求中自报 ActorContext。

| 操作 | 必须的 `kind` | 必须的 capability |
|---|---|---|
| `claim` | `worker` | `claim_delivery` |
| `transition_request(succeed|retry|die)` | `worker` | `record_delivery_result` |
| `transition_request(replay)` | `operator` | `replay` |
| `recover_expired_leases` | `system` | `recover_expired_leases` |
| scoped `query_outbox` / `query_notification` / `list_dead` / `list_attempt_history` | `operator` 或 `system` | `read_notifications` |
| global `query_outbox` | `system` | `read_all_notifications` |

ActorContext 缺失 / 无法验证 → `invalid-actor-context`；已认证且 scope 内但 kind 或 capability
不匹配 → `forbidden-action`；scope 不覆盖目标资源 → `not-found`。

本文中的 `store_now` 始终指 Store 在原子操作内取得的权威时钟值，不是 API / actor 输入；claim、
lease 校验、recovery、replay 与指标年龄均使用同一时钟域。

**`transition-request` 操作签名（NS-BR-01 · operation signature，非密码学签名）**

> `claim` 与 `recover_expired_leases` 为独立操作；Store 唯一的状态结果转换入口为
> `transition_request(request, actor_context)`。Operations Control 不获得第二个 Store replay 入口。

**公共字段**：`notification_id`；`requested_transition∈{succeed,retry,die,replay}`；
`expected_state`（必填）；`expected_version`（必填，乐观并发令牌）；`lease_id`
（`in_flight→*` 必填，`replay` 禁止）；variant-specific 字段见下表。

| transition variant | `delivery_result` | 其他必填 / 禁止字段 | `attempt_count` |
|---|---|---|---|
| `succeed` | `http_response + outcome_class=success + http_status` | `next_attempt_at`/`justification` 禁止 | +1 |
| `retry` | `http_response\|transport_failure + outcome_class=retryable_failure` | `next_attempt_at` 必填；`justification` 禁止 | +1 |
| `die`（实际尝试结果） | `http_response\|transport_failure + outcome_class=permanent_failure + reason` | HTTP/transport 可用 `deadline_exceeded`；其他 HTTP 使用 `non_retryable_http_status`，其他 transport 使用 `vendor_unreachable`；保留实际 `http_status`/`error_code`；`next_attempt_at` 禁止 | +1 |
| `die`（发送前策略终止） | `policy_termination + outcome_class=permanent_failure + reason` | reason 仅 `attempt_limit\|deadline_exceeded\|vendor_unavailable\|destination_rejected\|credential_unavailable\|request_unbuildable`；`http_status` / `error_code` / `next_attempt_at` 禁止 | 不变 |
| `replay` | **禁止** | `expected_state=dead`；operator `replay` capability；`justification` 合法 | 重置为 0 |

`unknown_result` **不属于 worker 可提交的 transition variant**；只由
`recover_expired_leases` 生成。任何表外组合 → `invalid-delivery-result`，无状态或历史副作用。

**前置校验**：`expected_version`≠当前 → `stale-version`；`expected_state`≠当前态 →
`illegal-transition`；`in_flight→*` 须 `lease_id`=当前 **且** `lease_expires_at>store_now`
**且** `actor_context.kind=worker`、具有 `record_delivery_result` capability、其
`actor_context.actor_id` 为 lease holder（不匹配/非持有人→`invalid-lease`；匹配但过期
→`expired-lease`）；`dead→pending` 须 `actor_context.kind=operator` + scope 覆盖 +
`replay` capability + 合法 `justification`。

**原子副作用（all-or-nothing）**：状态更新；version++；lease 设/清；`attempt_count`（按 Core
Spec D 的 `result_kind` 计数规则）；`last_outcome_class` / `last_error_code`；`next_attempt_at`；
`delivered_at`/`dead_at`/`dead_reason`/`replayed_at`；
`append_attempt` 行。

**last-result 更新矩阵**：

| 成功操作 | `last_outcome_class` | `last_error_code` |
|---|---|---|
| `claim` | 不变 | 不变 |
| `succeed(http_response)` | `success` | 清空 |
| `retry(http_response)` | `retryable_failure` | `http_status:<status>` |
| `retry(transport_failure)` | `retryable_failure` | `delivery_result.error_code` |
| `die`（实际结果或策略终止） | `permanent_failure` | `delivery_result.reason` |
| `recover_expired_leases` | `retryable_failure` | `lease_expired_unknown_result` |
| `replay` | 清空 | 清空 |

**结果**：成功 `{state, version, notification_id, lease_id?, attempt_count, delivery_cycle_started_at, replay_count, transitioned_at}`。
授权校验必须先于状态读取结果的对外构造：`not-found`（不存在或越权）仅返回
`{category=not-found, reason}`，**不得**携带 `current_state/current_version`；仅对已确认在 scope
内的既有通知，其他拒绝才可返回 `{category, reason, current_state?, current_version?}`。

**拒绝类别（D5）**：
- `invalid-actor-context`：缺失或无法验证的 authenticated server-internal actor context（HTTP 401/403
  映射由 composition 负责）；
- `not-found`：notification 不存在，或 actor 已认证但其 vendor scope 不包含目标 `vendor_id`（worker /
  operator 统一）；
- `forbidden-action`：actor 在 scope 内但缺少该动作能力（如 worker 试图 replay）；
- `invalid-delivery-result`：transition variant 与结果字段组合不合法；
- `invalid-lease-ttl`：claim TTL 越界；
- `invalid-justification`：replay justification 缺失、过短、过长或编码非法；
- `invalid-recovery-request`：recovery schema 携带 caller-supplied time 或其他禁止字段；
- `invalid-batch-limit` / `invalid-page-limit`：batch / page limit 越界；
- `invalid-cursor`：cursor 被篡改、scope/operation 绑定不匹配或格式非法；
- `clock-unavailable`：Store 权威时钟未通过健康检查，recovery fail closed；
- `illegal-transition`、`stale-version`、`invalid-lease`、`expired-lease`、`invariant-violation`
  保持不变。

**拒绝审计边界**：任何拒绝均不改变 state/version，也不追加 `DeliveryAttempt`。Store 仅发出
去敏结构化安全事件 `rejected_operation={category, actor_kind?, actor_id?, notification_id?,
requested_transition?, correlation_id, recorded_at}`；不得包含 payload、凭证、供应商响应体或
越权目标的当前状态。该事件属于运行日志契约，不是 Store 持久实体，也不参与状态事务原子性。
当 ActorContext 缺失或不可验证时，actor 字段允许为空，以 correlation id 追踪。

**不变量**：`transition-request` **不得**修改 `request_fingerprint`/`(caller_id, Idempotency-Key)`/
`vendor_id`/payload——intake 后不可变；任何可变签名草案均为违规。

**操作幂等性**：仅经 `expected_version` 实现——成功后重放同一请求返回 `stale-version`，调用方须处理。

### Interactions with Other Modules

> Delivery / Operations Control / Reliability Observability CDD 均已 Approved；本节跨模块契约已经
> 双向确认并为 binding。

**Delivery 消费**：`claim(filter?, lease_ttl, actor_context) → {notification_id, lease_id,
lease_expires_at, version, payload, vendor_id, attempt_count, delivery_cycle_started_at, created_at} | empty | Rejection`；
`transition_request(...)`（NS-BR-01，succeed/retry/die 的主调用方）；**无 lease 续约操作**（`lease_ttl`
由 Delivery 提供，Store 只校验正数与 Architecture 上限）；对 payload + `vendor_id` 的只读访问（构造出站
HTTP）。**不**消费：去重逻辑、接收校验、状态机内部、25/24h 策略判定。

**Operations Control 消费**：`query_outbox(filter?, actor_context) → {pending_count,
in_flight_count, delivered_count, dead_count, oldest_pending_age_seconds}`（BL-06 三项 + 健康附加）；
`query_notification(id, actor_context) → {state, version, attempt_count, delivery_cycle_started_at, replay_count,
last_outcome_class?, last_error_code?, lease, created_at, delivered_at?, dead_at?, replayed_at?}`；
`list_dead(filter?, limit?, cursor?, actor_context)`（snapshot-bounded live 游标分页）；
`list_attempt_history(notification_id, limit?, cursor?, actor_context) →
{items: AttemptRow[], next_cursor?}`（按 `(attempt_seq, attempt_id)` 升序的稳定游标分页）；
重放通过 canonical `transition_request(requested_transition=replay, ..., actor_context)`。
**不**消费：intake、claim、attempt 记录。

**查询 scope 规则**：
- 普通 `read_notifications` 查询的 `effective_scope` = ActorContext `vendor_scope` 与显式 vendor filter 的
  交集；未给 filter 时恰为 actor 的 `vendor_scope`。显式请求 scope 外 vendor → 无数据的 `not-found`
  （不得返回该 vendor 的计数或存在性）。
- `query_outbox` 的所有计数与 `oldest_pending_age_seconds` **只在 `effective_scope` 内聚合**。
- 只有 `kind=system + read_all_notifications` 可请求 global aggregate；普通 operator、普通 system 或
  wildcard 字符串均不能绕过 scope，越权 global 请求 → `forbidden-action`。

**Reliability Observability 消费**：仅以
`kind=system + read_all_notifications` 调用 global `query_outbox`，消费 `pending_count`、
`oldest_pending_age_seconds` 与 `dead_count` 三项固定聚合。**无 attempt-history 读取或写权限**；
不消费 in-flight、outcome、lease 或 per-vendor 指标；重放须经 Operations Control。

**Option A 接缝（`ValidatedIntake` handoff）**：
- 外部 HTTP 调用方提交闭合 envelope（`vendor_id` + `payload_base64`）与 Header `Idempotency-Key`；Caller Access
  校验 API Key → `caller_id` 与 key→`vendor_id` 授权范围；Vendor Registry 校验 `vendor_id` 存在且 active。
- ingress composition 构造内部 `ValidatedIntake`：`{caller_id, vendor_id, payload, idempotency_key}`，
  由受信任 composition 注入，调用方不可伪造。`ValidatedIntake` 的具体传输机制（in-process context、JWT、
  mTLS、签名 header）由 Architecture 决定。
- Store **只接收 `ValidatedIntake`**，不查询 Caller Access / Vendor Registry；external envelope 中自报
  `caller_id` / `is_verified` / URL / 未知字段由 intake 结构校验拒绝，不存在"静默忽略"路径。

**横切约束**：接口级同步（内部异步可，契约同步）；所有 list 形查询（含 attempt history）用
scope-bound、不可篡改、不透明的游标分页（非 offset——可变状态）；`limit` 省略时使用
`LIST_PAGE_DEFAULT`，显式值须为 `1..LIST_PAGE_MAX`；
Store 在自身边界校验 `ActorContext` 的服务端 claims（scope / action capability），不信任上游已校验；
`replay` 还须 `actor_context.kind=operator` + scope 覆盖 + `justification`；其余转换经 lease 持有权 + `ValidatedIntake` /
actor context 接缝；`transition_request` 幂等仅经 `expected_version`。查询与转换一样先完成授权再构造
资源结果；不存在与越权均只返回不含 state/version 的 `not-found`。

### Logical Responsibilities

> 四个**责任分区**（responsibility partitions），**不是**预设的类 / 包 / 文件。

**IntakeValidator** — 内部 `ValidatedIntake` 字段 / 类型 / 大小 / 幂等键格式校验；
`request_fingerprint` 规范化；去重键组成；持久化前拒绝畸形 `ValidatedIntake`。
纯决策 `ValidatedIntake → PersistableIntake | IntakeRejection[]`。外部 envelope 校验是 ingress composition
责任；`ValidatedIntake` 由受信任 composition 提供，IntakeValidator 不解释其来源，也不重新执行上游认证。
**不**拥有：调用方认证、供应商查找 / 授权、payload 语义、持久化、状态转换、尝试记录。

**OutboxRepository** — notification 持久化；唯一去重约束；原子接收写（单提交，`pending`）；乐观并发
version；claim/lease 持久化与查找；操作员查询（BL-06 指标）。CRUD + claim + versioned-update +
聚合查询。**不**拥有：状态机合法性（TransitionGuard 决定，本分区应用）、尝试记录（AttemptLog 同事务
追加）、接收校验。

**TransitionGuard** — 状态机（合法转换、终态）；前置校验（`expected_state`/`expected_version`/lease
有效性 / actor claims）；拒绝分类；重放授权。纯决策 `(current_state, version, lease, request, actor)
→ TransitionDecision | Rejection`。**不**拥有：持久化、尝试记录、接收校验、指纹计算。TransitionGuard
不评估 25/24h 上限或 deadline；上限判定由 Delivery 在调用 `die` 前完成，`reason` 仅作稳定审计分类。

**AttemptLog** — 仅追加写 attempt 行（与转换原子，Core Spec D）；attempt 行 schema；历史读。
`append_attempt(notification_id, attempt_data) → attempt_id`（转换原子单元内调用）；
`read_history_page(notification_id, limit, cursor?) → {items: AttemptRow[], next_cursor?}`，稳定顺序为
`(attempt_seq, attempt_id)` 升序。**不**拥有：状态机合法性、去重、接收校验。

**Lease 生命周期归属拆分**（多分区触及）：持久化（写 / 读 / 清 lease）→ OutboxRepository；有效性校验
（该 lease 对该 actor 是否仍有效）→ TransitionGuard；恢复动作（过期 → `pending`）→ TransitionGuard
（决策）+ OutboxRepository（应用）+ AttemptLog（审计），同一原子单元。

**组合点**：原子转换单元——TransitionGuard 决策、OutboxRepository 应用状态、AttemptLog 追加行，同事务。
查询面（操作员读路径 / BL-06）暂留 OutboxRepository（YAGNI）；仅在查询面膨胀时拆出第五分区 QueryFacet。

## Data Model

> 逻辑模型（stack-neutral）。不写 SQL / DDL / ORM / 连接池 / 迁移——均为 Architecture / ADR
> deferred。`request_fingerprint` 规范化算法 deferred 到幂等 ADR；CDD 级不变量："服务端计算、
> 持久化后不可变、按稳定字节比较"。identifier 具体形状（UUID / ULID / snowflake）由 Storage ADR
> 决定；CDD 只使用 opaque identifier。

**逻辑实体**：Notification（单一聚合根，D‑1）+ DeliveryAttempt（append-only 时间线）；lease 为
Notification 上的字段组（D‑2，非独立实体）；replay 折入 DeliveryAttempt（D‑3）。

### Notification（聚合根）

| 字段 | 类型 | 必填 | 约束 / 不变量 |
|---|---|---|---|
| `notification_id` | opaque id | Y | 服务端生成；不可变；主标识；具体形状由 Storage ADR 决定 |
| `caller_id` | string | Y | 来自 `ValidatedIntake`；**intake 后不可变** |
| `idempotency_key` | string | Y | 来自 `Idempotency-Key`；**intake 后不可变** |
| `vendor_id` | string | Y | 来自 `ValidatedIntake`；**intake 后不可变** |
| `request_fingerprint` | hash | Y | 服务端从 `ValidatedIntake` 计算；**持久化后不可变**；稳定字节比较 |
| `payload` | blob | Y | 规范化 vendor payload 字节；**intake 后不可变**；上限 256 KiB |
| `state` | enum | Y | `pending`/`in_flight`/`delivered`/`dead`；仅经状态机变更；BL-06 查询键 |
| `version` | int | Y | 单调；每次状态变更 +1；transition OCC 令牌 |
| `attempt_count` | int | Y | **当前 delivery cycle 的投递尝试计数**；按 `delivery_result.result_kind` 递增：`http_response` / `transport_failure` / `unknown_result` → +1；`claim` / `policy_termination` / `replay` → 不变；replay 时重置为 0 |
| `delivery_cycle_started_at` | ts | Y | intake 时 = `created_at`；replay 时 = `replayed_at` |
| `replay_count` | int | Y | 累计人工重放次数；每次 replay +1 |
| `created_at` / `updated_at` | ts | Y | created 不可变（oldest-pending 排序键）；updated 每次变更 |
| `next_attempt_at` | ts | N | retry 由 Delivery 设；recover/replay 使用 `store_now` |
| `delivered_at` | ts | N | 终态时间戳（D‑7 持久化） |
| `dead_at` / `dead_reason` | ts/str | N | 当前 cycle 的 dead 时间戳 / 原因；replay 时清除 |
| `last_outcome_class` / `last_error_code` | enum/str | N | 当前 cycle 最新结果去规范化（D‑7）；严格按 §last-result 更新矩阵 set/clear；`last_error_code` 仅为稳定去敏码，不含响应体 / payload / 凭证 |
| `lease_id` / `lease_expires_at` / `lease_holder` | opaque/ts/str | N | lease 字段组（D‑2）；holder 从 `ActorContext.actor_id` 推导；有效性由 `expires_at` 定义 |
| `replayed_at` / `replay_actor` / `replay_reason` | ts/str | N | 最近一次重放（完整历史在 DeliveryAttempt） |

**复合唯一键**：`(caller_id, idempotency_key)`（去重，负载关键）。

### DeliveryAttempt（append-only，与 Notification 1:N）

| 字段 | 类型 | 必填 | 约束 / 不变量 |
|---|---|---|---|
| `attempt_id` | opaque id | Y | 服务端生成；**write-once（不更新、不删除）**；形状由 Storage ADR 决定 |
| `notification_id` | opaque id | Y | FK→Notification；不变 |
| `attempt_seq` | int | Y | **每通知单调**（D‑8），从 1 起；复合唯一 `(notification_id, attempt_seq)` |
| `event_kind` | enum | Y | `claimed`/`outcome`/`recovery`/`replay`；插入后不可变 |
| `lease_id` | opaque | N | 授权该动作的 lease（清除后仍保留，供历史重建） |
| `actor` | string | Y | worker / operator / system 的 `ActorContext.actor_id` |
| `result_kind` | enum | Y（`outcome`/`recovery` 行） | `http_response` / `transport_failure` / `unknown_result` / `policy_termination` |
| `http_status` | int | 条件必填 | `http_response` 必填；其余 kind 必须为空 |
| `error_code` | enum/str | 条件必填 | `transport_failure` 必填；`http_response` / `unknown_result` 可选；`policy_termination` 必须为空 |
| `reason` | enum/str | 条件必填 | `die` / `unknown_result` / `policy_termination` 必填；实际失败=`non_retryable_http_status`/`vendor_unreachable`/`deadline_exceeded`，policy=`attempt_limit`/`deadline_exceeded`/`vendor_unavailable`/`destination_rejected`/`credential_unavailable`/`request_unbuildable`，unknown=`lease_expired_unknown_result` |
| `outcome_class` | enum | Y（`outcome`/`recovery` 行） | `success` / `retryable_failure` / `permanent_failure` |
| `error_summary` | str | N | 去敏简短摘要，不含完整响应体；任意 kind 均可选 |
| `replay_reason` | str | N | `replay` 行必填 |
| `recorded_at` | ts | Y | 事件服务端时间；不可变 |

`delivery_result` 是 `transition_request` 的逻辑输入判别联合；DeliveryAttempt **不再另存一份嵌套
struct**，而是在同一原子单元把已验证结果规范化为下表的 `result_kind` / `outcome_class` /
`http_status` / `error_code` / `reason` 字段。这些分解字段是持久化的唯一规范表示，禁止同时维护第二份
可能漂移的结果对象。`result_kind` / `outcome_class` 支持按 outcome 分组指标。Store 不保存供应商业务响应
body；原始响应证据（若需要）归 Delivery CDD / Architecture 决定，不进入 Store 的 load-bearing 状态。
Store 也不保存或决定供应商出站 `Content-Type`；该传输 Header 来自受控端点配置。

**`event_kind` 字段矩阵**

| `event_kind` | 规范化结果字段 | 固定 / 必填语义 |
|---|---|---|
| `claimed` | 禁止 | 记录 `lease_id` 与 worker actor；不增加 `attempt_count` |
| `outcome` | 必填 | 从合法 `succeed` / `retry` / `die` 的 `delivery_result` 分解写入 |
| `recovery` | 必填 | system actor；固定 `unknown_result + retryable_failure + lease_expired_unknown_result`；`attempt_count+1` |
| `replay` | 禁止 | operator + `replay_reason` 必填；重置 delivery cycle |

被拒操作不得创建上述任一行；其去敏 `rejected_operation` 只进入结构化运行日志。

**`delivery_result` 字段矩阵（按 `result_kind`）**

| `result_kind` | `outcome_class` | `http_status` | `error_code` | `reason` | `attempt_count` | 合法来源 |
|---|---|---|---|---|---|---|
| `http_response` | success / retryable / permanent（随 variant） | 必填 | 可选 | `die` 时为 `non_retryable_http_status` 或 `deadline_exceeded` | +1 | `succeed` / `retry` / actual-result `die` |
| `transport_failure` | retryable / permanent（随 variant） | 空 | 必填 | `die` 时为 `vendor_unreachable` 或 `deadline_exceeded` | +1 | `retry` / actual-result `die` |
| `unknown_result` | 固定 retryable | 空 | 可选 | 固定 `lease_expired_unknown_result` | +1 | 仅 `recover_expired_leases` |
| `policy_termination` | 固定 permanent | 空 | 空 | `attempt_limit` / `deadline_exceeded` / `vendor_unavailable` / `destination_rejected` / `credential_unavailable` / `request_unbuildable` | 不变 | 仅确定性 pre-send `die` |

矛盾组合（如 `policy_termination + http_status`）由 Store 返回 `invalid-delivery-result`，不得写状态或历史行。

### CDD 级不变量（非 SQL）

1. **复合去重唯一键** `(caller_id, idempotency_key)` 全局唯一；冲突必经接收判定矩阵。
2. **version 单调**：每次状态变更恰好 +1；`expected_version`≠当前 → 无副作用拒绝。
3. **append-only 尝试历史**：write-once；UPDATE/DELETE 契约层禁止；更正以新行。
4. **指纹不变性 + 稳定比较**：仅 intake 时服务端设一次；比较用稳定字节表示（算法 → 幂等 ADR）。
5. **intake 后不可变集** `{notification_id, caller_id, idempotency_key, vendor_id, request_fingerprint, payload, created_at}`。
6. **lease 单一性**：任一时刻每通知最多一个有效 lease；有效性由 `expires_at` 定义，非由 `lease_id` 存在与否。
7. **状态机合法性**：仅 §States 的 6 条转换合法；`delivered` 终态；replay 时 `attempt_count=0`、
   `delivery_cycle_started_at=replayed_at`、`replay_count++`。
8. **原子性（BL-03）**：intake 单元 = 插入 Notification 使其立即可投递；每个 transition 原子提交
   {state 变更, version++, attempt 行追加, `delivery_cycle_started_at` / `replay_count` 同步更新}。
9. **lease 跨历史关联**：每个 `claimed`/`outcome` 行记录授权 `lease_id`，即使 Notification 的 lease 已清。
10. **delivery cycle 边界**：`delivery_cycle_started_at` 与 `attempt_count` 同步重置；cycle 内
    `attempt_count` 只增不减；lifetime attempt 数由 DeliveryAttempt 派生。

### BL-06 查询契约 + 访问模式

- 所有指标均以经 ActorContext 授权后的 `effective_scope` 为边界：**outbox 深度** =
  scope 内 `state=pending` 计数；**最老 pending 年龄** =
  `store_now - min(created_at) where pending AND vendor_id∈effective_scope`；
  **dead 计数** = scope 内 `state=dead` 计数（外加 in_flight/delivered 附加）。只有
  `kind=system + read_all_notifications` 可取得全局 scope。`state` 为可枚举查询字段、
  `created_at` 在 pending 分区可查时**廉价**；逻辑模型须**不排除**维护型汇总（物理机制 Architecture
  deferred，但 `state` 转换须为可观察事件以使汇总可行）。
- 热路径：intake 去重（复合唯一键，O(log n)）、claim（`pending[+vendor_id]` +
  `next_attempt_at<=store_now` 谓词 +
  `(delivery_cycle_started_at,created_at,notification_id)` FIFO + 行级锁 SKIP LOCKED）、transition（PK + OCC）、
  lease 恢复扫描（紧 `(in_flight, lease_expires_at)`）。
- `list_dead` 使用 **snapshot-bounded live view**：第一页固定 `snapshot_at=store_now`，后续 cursor
  携带 scope 绑定、`snapshot_at` 与最后 `(dead_at, notification_id)`；仅扫描
  `state=dead AND dead_at<=snapshot_at`，按 `(dead_at, notification_id)` 升序。翻页开始后新转 dead 的行
  不进入本次遍历，下次新遍历可见；已被 replay 的行从后续页消失，因此允许少于第一页时的总数，
  但不得重复或返回已非 dead 的行。cursor scope 不匹配 / 被篡改 → `invalid-cursor`。
  `notification_id` 形状 Architecture deferred。
- `list_attempt_history` 游标锚定 `(attempt_seq, attempt_id)` 并按升序返回；cursor 同样绑定
  notification 与 effective scope。attempt 行 append-only，
  因此已翻页前缀不漂移，后续追加只出现在更后的页面。cursor 对调用方不透明，页大小受
  `LIST_PAGE_DEFAULT/MAX` 限制。

### Worked Example（stack-neutral）

> 以下示例使用伪值展示状态、version、cycle count、attempt count 满足不变量。identifier 形状仅为可读性。

**Intake（外部 → `ValidatedIntake`）**
- 外部 envelope：`{"vendor_id": "vendor-A", "payload_base64": "eyJldmVudCI6InJlZ2lzdGVyZWQifQ=="}`；
  ingress 严格解码为原始 `{"event":"registered"}` 字节
- Header：`Content-Type: application/json`、`Idempotency-Key: key-1`
- Caller Access：API Key → `caller_id = caller-1`，校验 `caller-1` 有权使用 `vendor-A`
- Vendor Registry：`vendor-A` 存在且 active
- `ValidatedIntake`：`{caller_id: "caller-1", vendor_id: "vendor-A", payload: {...}, idempotency_key: "key-1"}`
- 出站 `Content-Type` 不来自该命令；Delivery 随后从 `vendor-A` 的受控端点配置取得。

**Notification row after intake**

| 字段 | 值 |
|---|---|
| `notification_id` | `N1` |
| `caller_id` | `caller-1` |
| `idempotency_key` | `key-1` |
| `vendor_id` | `vendor-A` |
| `state` | `pending` |
| `version` | `1` |
| `attempt_count` | `0` |
| `delivery_cycle_started_at` | `2026-07-18T10:00:00Z` |
| `replay_count` | `0` |
| `created_at` | `2026-07-18T10:00:00Z` |

**After `claim` → `in_flight`**
- `state = in_flight`, `version = 2`, `attempt_count = 0`（claim 不计 HTTP 等价）
- `lease_id = L1`, `lease_expires_at = 2026-07-18T10:00:30Z`
- DeliveryAttempt row #1：`event_kind=claimed`, `attempt_seq=1`, `lease_id=L1`, `actor=worker-1`

**After successful `transition_request(succeed)` → `delivered`**
- `state = delivered`, `version = 3`, `attempt_count = 1`
- `delivered_at = 2026-07-18T10:00:05Z`
- DeliveryAttempt row #2：`event_kind=outcome`, `attempt_seq=2`, `lease_id=L1`, `actor=worker-1`, `http_status=200`, `outcome_class=success`

**After replay of an attempt-limit `dead` notification**
- 原 cycle：intake 后 `version=1`；25 轮 `claim + retryable outcome` 后，
  `state=pending`、`attempt_count=25`、`version=51`、`attempt_seq=50`。
- Delivery 再次 claim 以读取最新 cycle 元数据：`state=in_flight`、`version=52`、
  `attempt_seq=51`（claimed）。它在发送 HTTP **之前**判定已达上限，提交
  `die(policy_termination, outcome_class=permanent_failure, reason=attempt_limit)`。
- 策略终止后：`state=dead`、`attempt_count=25`（不增加）、`version=53`、
  `attempt_seq=52`、`dead_reason=attempt_limit`。
- `transition_request(replay, expected_state=dead, expected_version=53, ...)` 后：
  `state=pending`、`version=54`、`attempt_count=0`、
  `delivery_cycle_started_at=replayed_at`、`replay_count=1`。
- `dead_at` / `dead_reason` 清除；`next_attempt_at = store_now`
- DeliveryAttempt row #53：`event_kind=replay`, `attempt_seq=53`, `actor=operator-1`,
  `replay_reason="vendor endpoint connectivity restored"`

## Edge Cases

> 每项均为确定性判定（condition → 确切结果），不使用"合理处理 / 重试一下"等模糊措辞。
> 实现机制（GRANT 权限、hash-chain、KMS、advisory lock、显式列名 UPDATE）为 Architecture / ADR deferred。

**接收与去重**
- If 重复提交（同 `caller_id` + 同 `Idempotency-Key`）且 `request_fingerprint` 字节相等：返回既有
  `notification_id` + `202`，**零状态变更**（不新增 attempt 行、不增 version、不动 lease）。
- If 同键但 `request_fingerprint` 不同：`409 IdempotencyConflict`（稳定错误名 `IdempotencyConflict`），
  **不新增持久状态**；响应**不回显**任一指纹或字段差异（防侧信道）。
- If 并发同键提交：`(caller_id, idempotency_key)` 唯一约束在提交时仲裁——恰一个成功；败方在**新读
  事务**（锁定隔离级）重读胜方行并应用判定，不得盲返 5xx。
- If 指纹相等性：按**服务端规范化方案**重算后字节比较；精确算法 → 幂等 ADR。
- If Store 确认事务已回滚：返回 `commit-rolled-back`，不返回 id、**无行持久化**
  （composition 映射 `503`+`Retry-After`）；同键重试正常创建，除非另一个并发请求已提交。
- If commit 请求已发送但连接中断、结果不可确认：返回 `commit-outcome-unknown`，不返回 id
  （composition 映射 `503`+`Retry-After`）；同键重试可能返回已提交的既有 id，也可能创建一次
  新通知，但唯一约束保证绝不产生重复行。

**并发与租约**
- If 双重 claim 同一行：资格谓词包含 `state=pending`、`next_attempt_at<=store_now` 与 scope；恰一个成功。
  败方跳过并继续扫描，最终返回另一条可认领通知或 `empty`；指定同一 id 时返回 `empty`，
  **不**返回 `conflict`、不获得胜方 lease_id。
- If `expected_version`≠当前：无副作用 `stale-version`。
- If `lease_id` 不匹配 / actor≠holder：`invalid-lease`；匹配但 `lease_expires_at≤store_now`：`expired-lease`。
- If 过期 lease：**Store 不区分**"HTTP 未开始"与"HTTP 已发结果未知"——一律恢复 `in_flight→pending`，
  `attempt_count++`（current-cycle），写 `outcome=unknown_result` 审计行（at-least-once 固有重复为公开风险）。
  Store 的 recovery 本身不转 `dead`；Delivery 在下次 claim 后、发送 HTTP 前根据 cycle 元数据决定 `die`。
- If caller 在 recovery 请求中提交 `now` / timestamp：操作 schema 不接受该字段，返回
  `invalid-recovery-request`，零状态 / version / history 副作用。Store 只以同一权威时钟域签发
  `lease_expires_at` 并判断过期；权威时钟 unhealthy 时整批返回 `clock-unavailable`，不恢复任何 lease。
- If recovery `batch_limit<1` 或 `>RECOVERY_BATCH_MAX`：返回 `invalid-batch-limit`，零副作用。
- If worker 在 sweeper 恢复后才上报：transition 以 `expired-lease`/`stale-version` 拒绝；如有 outcome 信息，
  **不**写 DeliveryAttempt、不改状态；仅发出不含 payload/响应体的 `rejected_operation`
  结构化安全事件，以便事后核查。
- If sweeper 与 `delivered` 竞态：OCC 先提交者胜；接收方可能见重复（公开风险）。

**原子性与审计**
- If attempt 追加与状态更新同事务失败：整事务回滚；Store 返回内部重试指示（transition，composition 映射 `503`）或 `stale-version`（并发败方）。绝不"状态已变但缺 attempt 行"或反之。
- If DeliveryAttempt 行写入失败：intake/transition 回滚——生命周期历史与状态同事务，
  best-effort attempt history 被禁止。被拒操作的结构化安全事件不属于该事务。

**重放**
- If 重放 `dead`：条件更新 `state=dead AND version=expected`；须
  `actor_context.kind=operator` + scope 覆盖
  `vendor_id` + 非空 `justification`（min 20 / max 1 KiB，展示转义）；`attempt_count=0`、
  `delivery_cycle_started_at=replayed_at`、`replay_count++`；清除 `dead_at`/`dead_reason`；
  重置 `next_attempt_at=store_now`；旧 dead/replay 事实保留在 append-only history。
- If 重放非 `dead`（`pending`/`in_flight`/`delivered`）：`illegal-transition`；不追加
  DeliveryAttempt，仅发出 `rejected_operation` 安全事件。
- If 重复重放（两 operator 并发）：OCC 先者胜；败方 `stale-version`（返回当前 version），**不自动重试**。
- If 重放 `delivered`：不允许（终态）；需重新投递为独立新通知引用原 id，**不**重载 `replay`。
- If 线路重放同一 transition-request：OCC version 不匹配 → `stale-version`，无变更；无须 nonce。

**外部 envelope 校验与 DoS（ingress composition 责任，非 Store）**
- If body 非合法 JSON：`400 malformed_json`。If 必填字段缺失：`400 missing_field:<name>`。
- If 外部 envelope 含 `SCHEMA_FIELDS` 外字段（含 `caller_id`、`is_verified`、URL 等）：`400 unknown_field:<name>`。
- If 规范化 vendor payload 字节 >256 KiB：Store 返回 `payload-too-large`（composition 映射
  `413`）。整个 HTTP request 的流式读取上限由 ingress / Architecture 另行配置，不复用
  `PAYLOAD_MAX_BYTES`，但必须在构造 `ValidatedIntake` 前拒绝超限请求。
- If `Idempotency-Key` 缺失 / >255 字符 / 非 `[A-Za-z0-9._\-]{1,255}`：`400`（各自稳定码）。
- If 任一 envelope 标识字段含 NUL 字节：`400 invalid_byte_sequence`。Store 不在 CDD 中选择
  Unicode 规范化形式；payload/标识的精确规范化规则由幂等指纹 ADR 统一裁决，不记录 raw body。
- 以上校验由 ingress composition 在构造 `ValidatedIntake` 前完成；任一失败 → Store `accept` 未被调用。"闭合 envelope"= 外部结构校验；**vendor 专用 payload 字节不被 Store 解析或校验**。

**`ValidatedIntake` 与边界**
- If `ValidatedIntake` 内部字段缺失 / 类型错误 / 超限 / 非法 `idempotency_key`：返回
  `invalid-intake` 类拒绝（`invalid-intake` / `payload-too-large` / `invalid-idempotency-key`）。
- If worker/operator 请求缺失或无法验证其 authenticated server-internal actor context：返回
  `invalid-actor-context`；HTTP 401/403 映射由 composition 负责。
- If 外部请求在 body/query 携带 `caller_id`/`is_verified`/URL/未知字段：由 ingress composition
  拒绝，不存在"静默忽略"路径。
- If Option A 下 `vendor_id` unknown/draft/disabled/out-of-scope：ingress composition 在 Store
  **之前**将全部非 active 或越权负向合并为同一个不可区分结果；外部统一映射为 Caller Access
  定义的 `404 VendorUnavailable`，不持久化、无 Store 审计行。Store 若观测到
  `ValidatedIntake` 之外来源的 vendor_id → 内部不变量违反 `500`+P1 告警（非 4xx）。

**伪造与跨租户**
- If worker 伪造 `lease_id`/`actor`：条件更新含服务端推导的 `lease_holder`，不匹配 → `invalid-lease`，
  状态与 attempt history 不变；发出 `rejected_operation(category=invalid-lease)` 安全事件。
  具体传输机制（mTLS / internal token / in-process context）由 Architecture 决定。
- If worker scope（vendor A）访问 vendor B 通知：条件更新含 `vendor_id=<scope>`，跨租户返回
  **`not-found`**（worker / operator 统一，防存在性探测）。
- If operator/system（即使 actor id 与 holder 字符串相同）提交 `succeed` / `retry` / `die`，或
  worker 缺少 `record_delivery_result` capability：返回 `forbidden-action`，状态/version/history
  不变；ActorContext 的全局 principal id 与不可变 kind 绑定阻止跨 kind 身份碰撞。
- If worker 试图 replay：`forbidden-action`（replay 动作能力仅归 operator）。
- If operator scope 不覆盖目标 `vendor_id` 的重放：`not-found`。
- If operator 在 scope 内但缺少 replay 动作能力：`forbidden-action`。
- If operator 具备 replay capability 但 justification 非法：`invalid-justification`。

**上限边界**
- Store **不评估** `MAX_ATTEMPTS=25` / `MAX_AGE=24h` / deadline 优先级。Delivery 在调用 `transition_request(die)`
  前根据已批准策略完成评估，并通过闭合 `reason` 提供稳定审计分类：
  `attempt_limit` / `deadline_exceeded` / `vendor_unavailable` / `destination_rejected` /
  `credential_unavailable` / `request_unbuildable`。后四项只表示确定性未发送终止。
  `vendor_unreachable` 表示已发起或结果不可安全判为未发送的传输失败，归 `transport_failure`
  并计入 `attempt_count`，不是发送前 `policy_termination`。
- Store 的 expired-lease recovery 只执行 `in_flight→pending` + `unknown_result` 审计；不直接 `in_flight→dead`。

**时钟与扫描**
- If sweeper 多实例/误配高频：单例锁保证仅一个活跃；每周期至多 `RECOVERY_BATCH_MAX` 行；动作可审计
  （`actor=system`）。时钟健康检测与容许偏差的实现由 Architecture 决定，但 fail-closed
  `clock-unavailable` 行为是 CDD 约束。
- If `attempt_count` 将发生整数回绕：返回 `invariant-violation`，状态与历史不变；该保护不替代
  Delivery 拥有的 25 次业务上限。
- 加密 at rest 选型（column-level vs TDE）、hash-chain 审计、GRANT INSERT、单例锁实现 → Architecture / ADR。

## Dependencies

- **硬设计依赖：无**（Layer 0；Option A 保持 Store 为纯状态边界）。
- **`ValidatedIntake`**（opaque `caller_id` + 已授权 + active 确认的 `vendor_id` + `payload` +
  `idempotency_key`）是 ingress 组合层（Caller Access + Vendor Registry）提供的
  **组合前置条件**，**不是** Store 对这两个模块的运行时查询依赖——Store 从不调用它们。
- **下游消费者（消费已双向确认的 Store 契约）**：
  - **Delivery** — `claim`（含 cycle 元数据） / `transition_request` / 读 payload+`vendor_id`。
  - **Operations Control** — `query_outbox` / `query_notification` / `list_dead` /
    `list_attempt_history` / canonical `transition_request(replay)`。
  - **Reliability Observability** — 仅 global `query_outbox` 三项固定聚合只读。
- **双向列出**：上述模块的 CDD 须回列 "depended on by Notification Store" 的反向关系。
- **漂移守卫**：若本 CDD 任何设计决定实际要求 Store 运行时读取 Caller Access / Vendor Registry → 立即暂停，
  回到 Phase 2 Option B（经单独审批更新 module-index 的依赖边 / 层级 / 反向计数 / 设计顺序），
  **不允许**文档与 DAG 静默漂移。

## Configuration

> 只声明 Store **拥有或校验**的配置（类型 / 默认 / 安全范围 / 越界行为 / runtime reload / owner）。
> `SCHEMA_FIELDS={vendor_id, payload_base64}` 是外部 intake precondition，由 API schema 固定，不是 Store-owned
> runtime 配置。已批准的 PostgreSQL 方向不被否认；语言 / 框架 / 驱动版本为 Architecture deferred。

| 配置项 | 类型 | 默认值 | 安全范围 | 越界行为 | runtime reload | owner |
|---|---|---|---|---|---|---|
| `PAYLOAD_MAX_BYTES` | int | 256 KiB | >0 | 规范化 vendor payload 字节 >上限 → `payload-too-large` | 否 | Notification Store CDD |
| `IDEMPOTENCY_KEY_MAX_LEN` | int | 255 | 1..255 | 缺失 / 超长 → `invalid-idempotency-key` | 否 | Notification Store CDD |
| `IDEMPOTENCY_KEY_CHARSET` | regex | `[A-Za-z0-9._\-]{1,255}` | 固定 | 非法字符 → `invalid-idempotency-key` | 否 | Notification Store CDD |
| `JUSTIFICATION_MIN_LEN` | int | 20 | 1..1024 | replay 理由太短 → `invalid-justification` | 否 | Notification Store CDD |
| `JUSTIFICATION_MAX_LEN` | int | 1024 | ≥MIN | replay 理由太长 → `invalid-justification` | 否 | Notification Store CDD |
| `LEASE_TTL_MAX` | duration | 30s | >0 | `lease_ttl>LEASE_TTL_MAX` → `invalid-lease-ttl` | 否 | Architecture + Delivery CDD |
| `RECOVERY_BATCH_MAX` | int | 100 | 1..1000 | `batch_limit` 越界 → `invalid-batch-limit` | 否 | Notification Store CDD |
| `LIST_PAGE_DEFAULT` | int | 100 | 1..`LIST_PAGE_MAX` | 省略 `limit` 时使用；配置越界 → 启动失败 | 否 | Notification Store CDD |
| `LIST_PAGE_MAX` | int | 500 | 1..1000 | list `limit` 越界 → `invalid-page-limit` | 否 | Notification Store CDD |

**明确不归 Store（避免窃取下游策略）**：
- 出站 `idempotency_header` / `idempotency_body_field` → Vendor Registry / Delivery。
- 出站 `Content-Type` 与其他静态传输 Header → Vendor Registry / Delivery。
- `MAX_ATTEMPTS=25` / `MAX_AGE=24h` / full-jitter 退避 / deadline 判定 → Delivery 重试策略。
- 实际 `lease_ttl` 值、HTTP hard timeout、safety margin → Delivery / Architecture。
- sweeper cadence / leader election / batch scheduling → deployment / Architecture。
- `RETENTION` — **v1+ deferred**，不进 MVP 默认行为。

## Integration Requirements

> 本模块拥有 intake acceptance 与内部状态命令面，故该节必写。定义**行为契约**（非框架路由 / 中间件配置）。
> 出站 HTTP、供应商凭证、SSRF 算法、worker wake 实现均**不在本模块**（归 Delivery / Vendor Registry）。

**外部 intake 契约（HTTP）**
- `POST` 提交通知（具体路由 / OpenAPI 在 Architecture / 框架确定后生成）。
- 请求：`Content-Type: application/json` 的闭合 envelope
  （`SCHEMA_FIELDS = {vendor_id, payload_base64}`）；`payload_base64` 必须是规范 base64，严格解码后的原始
  bytes 才作为内部 `ValidatedIntake.payload`
  + Header `Idempotency-Key`（必填，`[A-Za-z0-9._\-]{1,255}`）。`vendor_id` 由调用方提交，
  经 Caller Access（key→vendor scope）和
  Vendor Registry（existence / active）校验后，由 ingress composition 构造内部 `ValidatedIntake`。
- Store 不直接暴露于外部 HTTP；外部错误映射由 composition 负责：
  - Caller Access 认证失败 → `401`；能力不足 → `403`；scope 不匹配或 Vendor Registry 返回任一
    unknown/draft/disabled/out-of-scope 非 active 事实 → 统一 `404 VendorUnavailable`；
  - 外部 envelope 未知字段 / 自报 `caller_id`/`is_verified`/URL → `400 unknown_field:<name>`（ingress composition）；
  - Store 内部拒绝（`invalid-intake` / `payload-too-large` / `invalid-idempotency-key`）由 composition 映射为 `400`/`413`；
  - Store 同键异指纹冲突 → `409 IdempotencyConflict`。
- 内部响应语义（从 Store 视角；HTTP 映射由 composition 完成）：新通知→`{notification_id}`；
  幂等重放→既有 id（零状态变更）；同键异指纹→`409 IdempotencyConflict`（不回显指纹）；
  结构错误→程序化 `invalid-intake` 类拒绝无行；确定回滚→`commit-rolled-back` 无 id/无行；
  提交结果未知→`commit-outcome-unknown` 无 id，同键重试由去重矩阵收敛。
- TLS 强制；调用方限流归 Caller Access；本模块**不做**调用方认证。
- 出站 `Content-Type` 不从外部请求或 `ValidatedIntake` 继承；由 Vendor Registry / Delivery
  的受控端点配置设置。

**内部状态命令契约（程序化操作，非 HTTP 路由）**
- `accept(ValidatedIntake) → {notification_id} | IntakeRejection[] | CommitFailure`
  （CommitFailure=`commit-rolled-back|commit-outcome-unknown`；均无 id）
- `claim(filter?, lease_ttl, actor_context) → {notification_id, lease_id, lease_expires_at, version, payload, vendor_id,
  attempt_count, delivery_cycle_started_at, created_at} | empty | Rejection`
- `transition_request(request, actor_context) → TransitionResult | Rejection`（NS-BR-01；variant
  字段矩阵见 §States and Transitions）
- `recover_expired_leases(batch_limit, actor_context) → RecoveredLease[] | empty | Rejection`
  （生产 schema 不接受 caller-supplied `now`；Store 权威事务时钟决定过期）
- `append_attempt(...)` —— **不独立暴露**；仅在 `claim`/`transition_request`/`recover` 的原子单元内调用（NS-BR-02）。
- `query_outbox(filter?, actor_context)` / `query_notification(id, actor_context)` /
  `list_dead(filter?, limit?, cursor?, actor_context) →
  {items: DeadNotificationSummary[], next_cursor?}` /
  `list_attempt_history(notification_id, limit?, cursor?, actor_context) →
  {items: AttemptRow[], next_cursor?}`（Operations Control 为主调用方；历史按
  `(attempt_seq, attempt_id)` 升序）；两类 list 均使用 `LIST_PAGE_DEFAULT/MAX` 与 scope-bound cursor；
  重放只经
  `transition_request(requested_transition=replay, ..., actor_context)`。
- 操作幂等：仅经 `expected_version`（成功后重放同请求→`stale-version`）。接口级同步（内部异步可，契约同步）。

**明确不包含**：出站 HTTP / 供应商凭证解析 / SSRF 校验算法 / worker wake（LISTEN/NOTIFY 等）实现 →
Delivery / Vendor Registry / Architecture。调用方认证 / `vendor_id` 授权范围 → Caller Access；
vendor existence / active / endpoint config → Vendor Registry（ingress 组合层在 Store 前构造
`ValidatedIntake`）；Option A 接缝已由 Caller Access 与 Vendor Registry Approved CDD 双向确认。

**auth / vendor-active 校验归属（Option A binding 接缝）**
- 调用方认证（API Key→`caller_id`）与 key→`vendor_id` 授权范围 → Caller Access。
- vendor existence / active 确认 → Vendor Registry。
- Store 只消费 `ValidatedIntake`，不重新校验；该接缝已由 Vendor Registry / Caller Access / Delivery
  Approved CDD 双向确认。

**需要的测试类型（行为级；具体框架 Architecture 定）**
- **契约测试**：接收判定矩阵（新/幂等/409/结构错误/未知字段）；确定回滚与提交结果未知的
  两类失败语义；ActorContext 必填；transition variant/result 字段矩阵；拒绝类别全覆盖
  （含 `invalid-actor-context` / `not-found` / `forbidden-action` /
  `invalid-delivery-result` / `invalid-justification` / `invalid-batch-limit` /
  `clock-unavailable`）；delivery-only kind/capability；replay 授权 + scope；越权
  `not-found` 不携带状态/version；scoped/global 指标授权；dead/history 的 scope-bound cursor、
  limit 与漂移语义；last-result set/clear 矩阵。
- **并发测试**：双重 claim 的确定性 skip/empty、未来 `next_attempt_at` 不可认领、stale version、
  lease 过期 vs 成功上报、重复重放、并发同键 intake。
- **集成测试**：intake→claim→transition→terminal 全生命周期；恢复 sweeper 的 Store-owned clock /
  batch cap / fail-closed；BL-06 指标查询；跨多页且含 replay 的 attempt history。
- **迁移测试**：schema 演进（append-only 历史保留、不可变字段不被迁移破坏）——具体在 Architecture/migration tooling 定后。
- **安全测试（负向）**：外部 body 自报 `caller_id`/`is_verified`/URL/未知字段被 ingress composition 拒绝（Store 不被调用）；跨租户→`not-found`；
  worker 试图 replay→`forbidden-action`；伪造 lease/ActorContext→`invalid-lease` 且只产生
  去敏 `rejected_operation`；普通 actor 请求 global 指标→`forbidden-action`；cursor 跨 scope
  复用→`invalid-cursor`；调用方不能控制出站 `Content-Type`。

## UI Requirements

**N/A — headless internal service.** 查询、重放与操作员面（API / CLI / 管理控制台）由 **Operations Control**
CDD 定义；Store 仅暴露 §Interactions 的程序化操作。本 CDD 不设计任何管理 UI。

## Acceptance Criteria

> 全部 **GIVEN-WHEN-THEN**，聚焦可观测行为 + 证据类型（Logic / Integration / API Contract），不引用具体测试框架 / SQL / 存储引擎。所有依赖 CDD 已 Approved，跨模块 AC 现为 binding。

**A. Intake / 去重**

- **AC-INTAKE-01**：**GIVEN** 不存在 `(caller_id, idempotency_key)` 既有行且 `ValidatedIntake` 结构合法，**WHEN** 调用 `accept` 提交，**THEN** 返回 `{notification_id}`（composition 映射 `202`），状态为 `pending`，`attempt_count=0`。[Integration]
- **AC-INTAKE-02**：**GIVEN** `(C1,K1)` 已存在通知 `N1` 且 `request_fingerprint` 为 `F1`，**WHEN** 以同键同指纹再次调用 `accept`，**THEN** 返回同一 `N1`（composition 映射 `202`），**零状态变更**（不新增 attempt 行、不增 `version`、不动 lease）。[Integration]
- **AC-INTAKE-03**：**GIVEN** `(C1,K1)` 已存在且指纹为 `F1`，**WHEN** 以同键但指纹 `F2` 调用 `accept`，**THEN** 返回程序化拒绝 `IdempotencyConflict`（composition 映射 `409`），**不回显**指纹或字段差异，不新增任何持久状态。[Integration]
- **AC-INTAKE-04**：**GIVEN** 两个并发 `accept` 使用相同 `(caller_id, idempotency_key)` 与相同指纹，**WHEN** 同时提交，**THEN** 由唯一约束仲裁后恰好一个成功创建新通知，另一个返回同一 `notification_id`，无重复行。[Integration]
- **AC-INTAKE-05**：**GIVEN** `ValidatedIntake` 缺字段、类型错误、payload 超限或 `idempotency_key` 非法，**WHEN** 调用 `accept`，**THEN** 返回程序化拒绝（`invalid-intake` / `payload-too-large` / `invalid-idempotency-key`），无行持久化。[Logic]
- **AC-INTAKE-05b**：**GIVEN** 外部 HTTP envelope 含未知字段 / `caller_id` / `is_verified` / URL，**WHEN** 进入 ingress composition，**THEN** 由 ingress 拒绝，Store `accept` 未被调用。[Integration Contract; owner: ingress composition]
- **AC-INTAKE-06a**：**GIVEN** Store 可确认 intake 事务已回滚，**WHEN** `accept` 报告提交失败，**THEN** 返回 `commit-rolled-back` 且无 `notification_id`、无 notification 行和可投递可见性；同键重试创建一次通知，除非另一个并发请求已成功提交。[Integration 故障注入]
- **AC-INTAKE-06b**：**GIVEN** commit 请求已发送但连接中断、提交结果无法确认，**WHEN** `accept` 返回，**THEN** 返回 `commit-outcome-unknown` 且无 `notification_id`；同键重试要么返回此前已提交的既有 id，要么创建恰好一条通知，唯一约束保证绝不重复。[Integration 故障注入]
- **AC-INTAKE-07**：**GIVEN** 两个不同 `caller_id` 使用相同 `idempotency_key` 与相同指纹，**WHEN** 分别调用 `accept`，**THEN** 各自创建独立通知，互不返回 `IdempotencyConflict`。[Integration]

**B. 原子性（BL-03）**

- **AC-ATOM-01**：**GIVEN** 新 intake 到达提交点，**WHEN** `accept` 成功，**THEN** notification 行与可投递可见性**同时出现**，外部观察者永不见"半提交"。[Integration]
- **AC-ATOM-02**：**GIVEN** Store 已确认 intake 事务回滚，**WHEN** `accept` 返回 `commit-rolled-back`，**THEN** notification 行与可投递可见性均不可观测；任一成功提交后立即查询，二者同时可观测。提交结果未知不适用“均不可观测”断言，按 AC-INTAKE-06b 收敛。[Integration 故障注入]
- **AC-ATOM-03**：**GIVEN** 一次 outcome transition，**WHEN** 原子单元提交，**THEN** attempt 行追加、状态变更、`version`+1 **同时可观测**；任一失败则前态完整。[Integration 故障注入；NS-BR-02]

**C. 状态机 / 转换（NS-BR-01）**

- **AC-STATE-01**：**GIVEN** 通知处于 `pending`、`next_attempt_at IS NULL OR next_attempt_at<=store_now`，且必填 `ActorContext` 为 `kind=worker`、具有 `claim_delivery` capability 并在 `vendor_id` scope 内，**WHEN** `claim(filter, lease_ttl, actor_context)` 传入 `lease_ttl>0` 且 ≤`LEASE_TTL_MAX`，**THEN** 状态变为 `in_flight`，`version`+1，写入 `claimed` 行，`lease_holder=actor_context.actor_id`，返回包含 `attempt_count`、`delivery_cycle_started_at`、`created_at` 的 cycle 元数据。[Integration]
- **AC-STATE-02**：**GIVEN** 通知处于 `in_flight`、lease 有效且 holder 为具有 `record_delivery_result` capability 的 worker，**WHEN** worker 调用 `transition_request(succeed)` 并给出 `delivery_result(result_kind=http_response, http_status, outcome_class=success)`，**THEN** 状态变为 `delivered`，`version`+1，清除 lease，`attempt_count`+1，写入 `outcome` 行；Store 不要求也不保存完整响应体或原始响应证据。[Integration; BL-05]
- **AC-STATE-03**：**GIVEN** 通知处于 `in_flight`、lease 有效且 holder 为具有 `record_delivery_result` capability 的 worker，**WHEN** worker 调用 `transition_request(retry)` 并给出 `delivery_result(result_kind=http_response|transport_failure, outcome_class=retryable_failure)` 与必填 `next_attempt_at`，**THEN** 状态回到 `pending`，`version`+1，清除 lease，`attempt_count`+1，持久化 `next_attempt_at`，写入 `outcome` 行。[Integration]
- **AC-STATE-04a**：**GIVEN** 通知处于 `in_flight`、lease 有效且 holder 为具有 `record_delivery_result` capability 的 worker，**WHEN** Delivery 调用 `transition_request(die)` 并给出 `delivery_result(result_kind=http_response|transport_failure, outcome_class=permanent_failure, reason=non_retryable_http_status|vendor_unreachable|deadline_exceeded)`，**THEN** 状态变为 `dead`，`version`+1，清除 lease，保留实际 `http_status` 或 `error_code`，`attempt_count`+1，禁止 `next_attempt_at`，设置 `dead_at`/`dead_reason`，写入 `outcome` 行。[Integration]
- **AC-STATE-04b**：**GIVEN** 通知处于 `in_flight`、lease 有效且 holder 为具有 `record_delivery_result` capability 的 worker，**WHEN** Delivery 调用 `transition_request(die)` 并给出 `delivery_result(result_kind=policy_termination, outcome_class=permanent_failure, reason∈{attempt_limit,deadline_exceeded,vendor_unavailable,destination_rejected,credential_unavailable,request_unbuildable})`，**THEN** 状态变为 `dead`，`version`+1，清除 lease，`attempt_count` 不变，设置 `dead_at`/`dead_reason`，写入 `outcome` 行；`http_status`、`error_code` 与 `next_attempt_at` 均为空。[Integration]
- **AC-STATE-05**：**GIVEN** 通知处于 `dead` 且 operator ActorContext 在 `vendor_id` scope 内、具有 `replay` capability 并附合法 `justification`，**WHEN** 调用 canonical `transition_request(replay)` 且 `expected_state=dead`、`expected_version` 匹配、未携带 `delivery_result`，**THEN** 状态变为 `pending`，`version`+1，`attempt_count` 重置为 `0`，`delivery_cycle_started_at` 更新为 `replayed_at=store_now`，`replay_count`+1，清除 `dead_at`/`dead_reason`，重置 `next_attempt_at=store_now`，写入 `replay` 行，旧 dead/replay 事实保留在 append-only 历史。[Integration]
- **AC-STATE-06**：**GIVEN** 通知处于 `delivered`，**WHEN** 任何非 noop `transition_request`（含 `replay`），**THEN** 返回 `illegal-transition`，状态、`version`、日志不变。[Integration]
- **AC-STATE-07**：**GIVEN** 通知处于 `pending`，**WHEN** 直接调用 `transition_request(succeed)` 或 `transition_request(die)`，**THEN** 返回 `illegal-transition`，状态、`version`、日志不变。[Integration]
- **AC-STATE-08**：**GIVEN** 通知当前 `version` 为 `V`，**WHEN** `transition_request` 携带 `expected_version≠V`，**THEN** 返回 `stale-version`，无任何副作用。[Integration]
- **AC-STATE-09**：**GIVEN** `notification_id` 不存在或 ActorContext 的 `vendor_scope` 不包含目标通知，**WHEN** worker/operator/system 调用查询或转换，**THEN** 统一返回 `not-found`，响应不携带 `current_state`、`current_version` 或其他可区分存在性的字段。[Integration; NS-BR-04]
- **AC-STATE-10**：**GIVEN** worker ActorContext 在 scope 内但缺少 `replay` capability，**WHEN** 调用 `transition_request(replay)`，**THEN** 返回 `forbidden-action`。[Integration]
- **AC-STATE-11**：**GIVEN** claim/query/transition/recovery 操作缺失或无法验证 server-internal ActorContext，**WHEN** 调用 Store，**THEN** 返回 `invalid-actor-context`。[Integration]
- **AC-STATE-12**：**GIVEN** 两个并发 transition 携带相同 `expected_version`，**WHEN** 同时提交，**THEN** 恰好一个成功，另一个返回 `stale-version`。[Integration]
- **AC-STATE-13**：**GIVEN** 任意被拒 Store 操作，**WHEN** 返回已定义 taxonomy 中的拒绝（含 `stale-version`/`illegal-transition`/`invalid-lease`/`expired-lease`/`forbidden-action`/`not-found`/`invalid-actor-context`/`invalid-delivery-result`/`invalid-lease-ttl`/`invalid-justification`/`invalid-recovery-request`/`invalid-batch-limit`/`invalid-page-limit`/`invalid-cursor`/`clock-unavailable`/`invariant-violation`），**THEN** `version` 不变、不追加 attempt 行、状态不变；仅允许发出不含 payload、凭证、响应体或目标当前状态的 `rejected_operation` 安全事件。[Logic]
- **AC-STATE-14**：**GIVEN** `transition_request` 的 variant 字段不符合 §States 表格，**WHEN** Store 校验 `requested_transition × result_kind × outcome_class`，**THEN** 返回 `invalid-delivery-result`，状态/version/attempt history 不变。[Logic]
- **AC-STATE-15**：**GIVEN** 任一合法 outcome/recovery/replay，**WHEN** 原子转换提交，**THEN** `last_outcome_class` / `last_error_code` 严格按 §last-result 更新矩阵 set/clear：成功清 error，retry 记录稳定 HTTP/transport 码，die 记录 reason，recovery 记录 `lease_expired_unknown_result`，replay 清空二者；查询返回同一规范字段。[Integration]
- **AC-STATE-16**：**GIVEN** 通知处于 `in_flight` 且 lease id / holder 字符串均匹配，**WHEN** operator/system 调用 `succeed|retry|die`，或 worker 缺少 `record_delivery_result` capability，**THEN** 返回 `forbidden-action`，状态/version/attempt history 不变；只有 `kind=worker` 且具有该 capability 的 holder 可提交投递结果。[Integration]
- **AC-STATE-17**：**GIVEN** operator/system 调用 `claim`，或 worker 缺少 `claim_delivery` capability，**WHEN** Store 校验 ActorContext，**THEN** 返回 `forbidden-action` 且不签发 lease、不写 `claimed` 行；只有 scope 内的 `kind=worker + claim_delivery` 可认领。[Integration]

**D. Lease / 并发**

- **AC-LEASE-01**：**GIVEN** 合法 `claim` 请求携带 `lease_ttl>0` 且 ≤`LEASE_TTL_MAX`，**WHEN** Store 签发 lease，**THEN** `lease_expires_at=store_now+lease_ttl`，`lease_id` 为服务端生成的不透明值，且无 `extend_lease` 成功路径。[Integration]
- **AC-LEASE-02**：**GIVEN** 一个 worker 正在认领或已认领某通知，**WHEN** 第二个 worker 执行扫描式 `claim`，**THEN** 跳过该通知并返回下一条可认领通知或 `empty`；指定同一 `notification_id` 时返回 `empty`，不返回 `conflict`，不暴露胜方 lease，目标通知不因败方发生额外 `version` 变化。[Integration]
- **AC-LEASE-03**：**GIVEN** 通知处于 `in_flight` 且 `lease_expires_at≤store_now`，**WHEN** 原 worker 用该 `lease_id` 提交 transition，**THEN** 返回 `expired-lease`，不修改状态。[Integration; NS-BR-03]
- **AC-LEASE-04**：**GIVEN** 通知处于 `in_flight`，**WHEN** worker 提交伪造 lease 或 `actor_context.actor_id`≠`lease_holder`，**THEN** 返回 `invalid-lease`，状态与 attempt history 不变，并发出去敏 `rejected_operation(category=invalid-lease)`。[Integration]
- **AC-LEASE-05**：**GIVEN** 任何 `extend_lease` 或等价续约操作，**WHEN** 对 Store 发起调用，**THEN** 不存在成功路径，`lease_expires_at` 签发后不可变更。[API Contract 负向]
- **AC-LEASE-06**：**GIVEN** `claim` 携带 `lease_ttl≤0` 或 `lease_ttl>LEASE_TTL_MAX`，**WHEN** Store 校验，**THEN** 拒绝（`invalid-lease-ttl`）；Store 不使用 HTTP timeout 或 margin 推导 TTL。[API Contract]
- **AC-LEASE-07**：**GIVEN** 具备 recovery capability 的 system ActorContext 且扫描到 lease 过期通知，**WHEN** 执行 `recover_expired_leases`，**THEN** 状态 `in_flight→pending`，清除 lease，`version`+1，追加 `delivery_result(unknown_result, retryable_failure, lease_expired_unknown_result)` recovery 行，`attempt_count`+1；Store 不直接转为 `dead`。[Integration; NS-BR-03]
- **AC-LEASE-08**：**GIVEN** 一组 `pending` 通知包含尚未到期行、多个 eligible cycle 及 replay 后的新 cycle，**WHEN** worker 执行扫描式或指定 id 的 `claim`，**THEN** `next_attempt_at>store_now` 的目标不可认领且状态/version 不变；扫描式调用只在 eligible 行中按 `(delivery_cycle_started_at,created_at,notification_id)` 升序选择下一条或返回 `empty`，replay 行按重置后的 cycle 时间排序。[Integration]
- **AC-LEASE-09**：**GIVEN** 某 lease 按 Store 权威时钟仍未过期，**WHEN** system recovery 请求试图携带未来 `now` / timestamp，**THEN** schema 以 `invalid-recovery-request` 拒绝，lease、状态、version、attempt history 均不变；生产 recovery 操作不存在覆盖 Store 时钟的参数。[API Contract + Integration]
- **AC-LEASE-10**：**GIVEN** recovery `batch_limit` 越界或 Store 权威时钟未通过健康检查，**WHEN** 调用 `recover_expired_leases`，**THEN** 分别返回 `invalid-batch-limit` 或 `clock-unavailable`，整批零副作用；合法批次至多恢复 `RECOVERY_BATCH_MAX` 行。[Integration]

**E. 尝试 / 恢复**

- **AC-ATT-01**：**GIVEN** 一次 `claim` 转换，**WHEN** 提交成功，**THEN** 追加 `claimed` 行且所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-02**：**GIVEN** 一次 `succeed` 转换，**WHEN** 提交成功，**THEN** 追加 `outcome` 行且所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-03**：**GIVEN** 一次 `retry` 转换，**WHEN** 提交成功，**THEN** 追加 `outcome` 行且所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-04**：**GIVEN** 一次 `die` 转换，**WHEN** 提交成功，**THEN** 追加 `outcome` 行并记录 `delivery_result`；`http_response` / `transport_failure` 使 `attempt_count`+1，`policy_termination` 不改变计数；worker 不可通过 transition 提交 `unknown_result`；所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-05**：**GIVEN** 一次 `replay` 转换，**WHEN** 提交成功，**THEN** 追加 `replay` 行且所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-06**：**GIVEN** 一次 lease recovery，**WHEN** 提交成功，**THEN** 追加 `event_kind=recovery` 且固定携带 `unknown_result + retryable_failure + lease_expired_unknown_result`，所有旧 attempt 行不被更新或删除。[Logic]
- **AC-ATT-07**：**GIVEN** 通知经历多次转换，**WHEN** 读取 attempt history，**THEN** 所有 attempt 行保持 write-once，契约层禁止 UPDATE/DELETE。[Logic; NS-BR-02]
- **AC-ATT-08**：**GIVEN** `claim` 后接 `succeed`（`result_kind=http_response`），**WHEN** 统计 `attempt_count`，**THEN** `attempt_count=1`（`claimed` 行不计入；`policy_termination` 也不计入）。[Integration; NS-BR-02]
- **AC-ATT-09**：**GIVEN** `attempt_count` 的下一次递增将发生整数回绕，**WHEN** Store 提交转换，**THEN** 返回 `invariant-violation`，计数不回绕且状态/历史不变；此保护不替代 Delivery 的 25 次业务上限。[Logic]
- **AC-ATT-10**：**GIVEN** 已过期 lease 被恢复为 `pending`（`result_kind=unknown_result`），**WHEN** 在同一 delivery cycle 中进入下一次 `claim`，**THEN** `attempt_count` 已 +1，Delivery 根据 `attempt_count` 与未重置的 `delivery_cycle_started_at` 决定 `die`；Store 仅在收到显式 `die` 时转 `dead`。[Integration]
- **AC-ATT-11**：**GIVEN** 一次 `transition_request` 的 `delivery_result` 含矛盾字段（如 `result_kind=policy_termination` 但 `http_status` 非空），**WHEN** Store 校验，**THEN** 返回 `invalid-delivery-result`，不写状态或历史行。[Logic]
- **AC-ATT-12**：**GIVEN** 任意 DeliveryAttempt 新行，**WHEN** 按 `event_kind` 校验，**THEN** `claimed`/`replay` 禁止规范化结果字段，`outcome` 字段必须来自合法 transition variant，`recovery` 字段固定为 unknown-result 组合。[Logic]
- **AC-ATT-13**：**GIVEN** 合法 `delivery_result` 输入，**WHEN** Store 追加 outcome/recovery DeliveryAttempt，**THEN** 只持久化规范化分解字段 `result_kind/outcome_class/http_status/error_code/reason`，不另存一份可能漂移的嵌套 `delivery_result`；读回可唯一重建逻辑结果。[Logic]

**F. 历史分页**

- **AC-HIST-01**：**GIVEN** 已授权 operator/system 调用 `query_notification`，**WHEN** Store 返回通知摘要，**THEN** 响应不内联无界 `history[]`；历史只能经 `list_attempt_history(notification_id, limit?, cursor?, actor_context)` 读取，省略 `limit` 使用 `LIST_PAGE_DEFAULT`，显式值必须为 `1..LIST_PAGE_MAX`。[API Contract]
- **AC-HIST-02**：**GIVEN** 一条通知具有跨多个页面的 claim/outcome/recovery/replay 历史，**WHEN** 调用方沿 `next_cursor` 读取全部页面，**THEN** 行按 `(attempt_seq, attempt_id)` 严格升序且无重复、无遗漏；翻页期间新追加行只出现在后续页面。[Integration]
- **AC-HIST-03**：**GIVEN** ActorContext 缺少 `read_notifications` capability、scope 不覆盖目标或 `limit` 越界，**WHEN** 调用 `list_attempt_history`，**THEN** 分别返回 `forbidden-action`、无 state/version 的 `not-found` 或 `invalid-page-limit`，且不返回任何历史行。[Integration]
- **AC-LIST-01**：**GIVEN** scope 内存在多个 dead 通知，**WHEN** 首次调用 `list_dead(filter?, limit?, cursor?, actor_context)`，**THEN** 固定 `snapshot_at=store_now`，只返回 `effective_scope` 内且 `dead_at<=snapshot_at` 的行，按 `(dead_at, notification_id)` 严格升序，页大小使用 `LIST_PAGE_DEFAULT` 或合法显式 limit。[Integration]
- **AC-LIST-02**：**GIVEN** 正在沿 `list_dead` cursor 翻页，**WHEN** snapshot 后出现新 dead 行且既有 dead 行被 replay，**THEN** 新行不进入本次遍历、下次新遍历可见；已 replay 行不再返回；其余 eligible 行无重复，允许因 replay 少于起始时集合。[Integration]
- **AC-LIST-03**：**GIVEN** `list_dead` 的 limit 越界、cursor 被篡改或 cursor 与 ActorContext scope / operation 不匹配，**WHEN** Store 校验请求，**THEN** 分别返回 `invalid-page-limit` 或 `invalid-cursor`，不返回列表数据；显式请求 scope 外 vendor 返回无计数/状态的 `not-found`。[Integration]

**G. 不可变性**

- **AC-IMM-01**：**GIVEN** 任意已 intake 通知，**WHEN** 全生命周期查询，**THEN** `request_fingerprint` 保持不变。[Logic]
- **AC-IMM-02**：**GIVEN** 任意已 intake 通知，**WHEN** 全生命周期查询，**THEN** `(caller_id, idempotency_key)` 保持不变。[Logic]
- **AC-IMM-03**：**GIVEN** 任意已 intake 通知，**WHEN** 全生命周期查询，**THEN** `vendor_id`、`payload`、`created_at` 保持不变。[Logic]
- **AC-IMM-04**：**GIVEN** 任意状态变更序列，**WHEN** 每次成功转换后，**THEN** `version` 恰好 +1，且不下降、不跳跃。[Logic]

**H. 安全 / 边界（Option A）**

- **AC-SEC-01**：**GIVEN** 外部 envelope 包含 `caller_id`、`is_verified`、URL 或 `SCHEMA_FIELDS` 外未知字段，**WHEN** 进入 ingress composition，**THEN** 由 ingress 拒绝，Store 不采用调用方自报值。[Integration Contract; owner: ingress composition; NS-BR-04]
- **AC-SEC-02**：**GIVEN** 受信任 composition 构造的 `ValidatedIntake`，**WHEN** Store 处理，**THEN** 使用其中 opaque `caller_id`/`vendor_id` 作为已验证值，不重新查询 Caller Access 或 Vendor Registry。[API Contract]
- **AC-SEC-03**：**GIVEN** worker scope 覆盖 vendor A 但访问 vendor B 的通知，**WHEN** 调用查询或转换，**THEN** 返回 `not-found`，且响应不包含 `current_state`、`current_version` 或其他目标状态信息。[Integration; NS-BR-04]
- **AC-SEC-04**：**GIVEN** Store 运行时代码边界，**WHEN** 审查依赖图，**THEN** Store 不向 Vendor Registry 发出运行时出站查询，依赖仅为静态组合前置条件。[API Contract / Static Dependency]
- **AC-SEC-05**：**GIVEN** 通知处于 `in_flight`，**WHEN** worker 使用伪造 lease 或错误 ActorContext 提交 transition，**THEN** 返回 `invalid-lease`，不追加 DeliveryAttempt，并发出不含敏感字段的 `rejected_operation`。[Integration]
- **AC-SEC-06**：**GIVEN** worker ActorContext 在 scope 内，**WHEN** 试图调用 `transition_request(replay)`，**THEN** 返回 `forbidden-action`。[Integration]
- **AC-SEC-07**：**GIVEN** operator 在 scope 内，**WHEN** 缺少 `replay` capability 则调用 canonical `transition_request(replay)`，**THEN** 返回 `forbidden-action`；若 capability 存在但 justification 不合法则返回 `invalid-justification`；scope 不覆盖仍返回 `not-found`。[Integration]
- **AC-SEC-08**：**GIVEN** Store intake、Notification 与 claim schema，**WHEN** 审查出站传输 Header 归属，**THEN** schema 不接受或持久化调用方 `content_type`，Delivery 仅从受控 Vendor Registry 端点配置取得出站 `Content-Type`。[API Contract; BL-05]

**I. BL-06 指标**

- **AC-MET-01**：**GIVEN** ActorContext 具有 `read_notifications` 且 `effective_scope=S`，**WHEN** 调用 `query_outbox`，**THEN** outbox 深度等于 S 内 `pending` 计数，不包含 S 外通知。[Integration]
- **AC-MET-02**：**GIVEN** ActorContext 具有 `read_notifications` 且 `effective_scope=S`，**WHEN** 调用 `query_outbox`，**THEN** 有 pending 时最老年龄等于 `store_now - min(created_at where pending AND vendor_id∈S)`，无 pending 时固定为 `0`，S 外行不影响结果。[Integration]
- **AC-MET-03**：**GIVEN** ActorContext 具有 `read_notifications` 且 `effective_scope=S`，**WHEN** 调用 `query_outbox`，**THEN** dead 计数等于 S 内 `dead` 计数，不包含 S 外通知。[Integration]
- **AC-MET-04**：**GIVEN** scoped 指标与 notification 状态，**WHEN** 在同一 `effective_scope` 重算，**THEN** 三者可由该 scope 内状态重算且无漂移（或维护计数器与 scoped 状态一致）。[Logic]
- **AC-MET-05**：**GIVEN** `kind=system` 且 ActorContext 具有 `read_all_notifications`，**WHEN** 明确请求 global `query_outbox`，**THEN** 聚合覆盖全部 vendor；没有该专用 capability 的 operator/system 请求 global 时返回 `forbidden-action` 且不返回任何计数。[Integration]
- **AC-MET-06**：**GIVEN** 普通 `read_notifications` actor 显式 filter 到其 `vendor_scope` 外 vendor，**WHEN** 调用 `query_outbox`，**THEN** 返回不含计数/年龄的 `not-found`，不泄露该 vendor 是否存在或有任务。[Integration]

**J. 上限边界**

- **AC-DL-01**：**GIVEN** Store 的 `transition_request` 接口，**WHEN** 审查输入 schema，**THEN** 不存在任意 `policy_inputs` 字段；Store 不持有 `MAX_ATTEMPTS`/`MAX_AGE` 常量。[API Contract]
- **AC-DL-02**：**GIVEN** 通知处于 `in_flight` 且 Delivery 决定终止，**WHEN** Store 收到 `transition_request(die, reason)`，**THEN** 仅校验状态/`version`/lease/actor/recognized reason；上限、deadline、vendor 可用性、目标、凭证与请求可构造性判定均由 Delivery 在调用前完成。[API Contract]

**K. NS-BR-05 子职责边界（coverage mapping — 非独立可测 AC）**

- **NSBR-05a**：**IntakeValidator**：内部 `ValidatedIntake` 字段 / 类型 / 大小 / 幂等键格式错误 → 程序化 `invalid-intake` 类拒绝（`invalid-intake` / `payload-too-large` / `invalid-idempotency-key`）；同键异指纹 → `409 IdempotencyConflict`；否则 `202`；rejection 原因可观测。〔coverage mapping; 非独立 AC〕
- **NSBR-05b**：**OutboxRepository**：intake 原子写、确定回滚 / 提交结果未知语义、可投递可见性、versioned update、claim 资格/lease/scoped 查询；见 AC-INTAKE-06a..06b、AC-ATOM-01..03、AC-LEASE-02、AC-LEASE-08、AC-LIST-01..03、AC-MET-01..06。〔coverage mapping; 非独立 AC〕
- **NSBR-05c**：**TransitionGuard**：合法转换、前置校验、拒绝类别全集；见 AC-STATE-01..17（含 04a/04b）、AC-LEASE-03..10、AC-SEC-05..08、AC-ATT-11。〔coverage mapping; 非独立 AC〕
- **NSBR-05d**：**AttemptLog**：每次成功转换至多追加一行、行类型与事件匹配、历史稳定分页；见 AC-ATT-01..07、ATT-11..13、AC-HIST-01..03。〔coverage mapping; 非独立 AC〕

**NS-BR 覆盖矩阵**

| 边界 | AC |
|---|---|
| **NS-BR-01**（transition 签名 + 拒绝语义） | STATE-01..17, LEASE-02..04, LEASE-06..10, SEC-05..08, NSBR-05c |
| **NS-BR-02**（attempt 归 Store + 逻辑 `append_attempt` 原子） | ATT-01..07, ATT-11..13, HIST-01..03, ATOM-03, NSBR-05d |
| **NS-BR-03**（过期恢复计为 attempt） | ATT-06, ATT-10, LEASE-03, LEASE-07, LEASE-09..10 |
| **NS-BR-04**（`caller_id` 服务端产生的不透明已验证输入；外部自报字段拒绝） | INTAKE-05, INTAKE-05b, SEC-01, SEC-02, STATE-09 |
| **NS-BR-05**（四逻辑子职责命名 + 边界） | NSBR-05a..d（coverage mapping 项，非独立 AC） |

**标记项**：AC-LEASE-05（证明操作**缺席**）以 API Contract 审查为承载证据；AC-SEC-04（无 Vendor Registry 出站）为静态依赖图审查；AC-ATT-10 的 deadline/上限判定在 Delivery，Store 仅响应显式 `die`；AC-STATE-13 覆盖拒绝的 state/version/attempt 不变性与去敏安全事件边界。


## Open Questions / Deferred Implementation Decisions

> 每项使用下表记录 owner、resolution gate、calendar due、blocking 状态。没有项目排期时，
> `Calendar Due = N/A — schedule not established`，不得编造日期。已由宪法或 `active_context` 批准的
> PostgreSQL / API Key / SSRF 立场**不是** Open Question——仅其具体实现 deferred。

| Decision | Owner | Resolution Gate | Calendar Due | Blocking? |
|---|---|---|---|---|
| PostgreSQL 物理 schema / DDL / 事务与锁 SQL / 连接池 / migration tooling | Architecture ADR: PostgreSQL outbox + concurrency | before Implementation | N/A — schedule not established | Yes |
| `request_fingerprint` 规范化算法 | Architecture ADR: idempotency fingerprint | before Implementation | N/A — schedule not established | Yes |
| 语言 / 框架 / 驱动 / 版本 | `/setup-engine` | before Architecture gate | N/A — schedule not established | Yes |
| 加密 at rest 选型（column-level + KMS vs TDE）+ 密钥轮换 cadence | Architecture ADR: data protection | before Implementation | N/A — schedule not established | No |
| sweeper 单例锁实现（advisory lock / leader-election）+ 每周期行数上限 | Architecture + deployment | before Implementation | N/A — schedule not established | No |
| BL-06 维护型汇总（rollup）物理机制 | Architecture + Performance | v1 trigger | N/A — schedule not established | No |
| Delivery retry 策略常量（`MAX_ATTEMPTS` / `MAX_AGE` / full-jitter） | Delivery CDD | before Implementation | N/A — schedule not established | Yes |
| 实际 `lease_ttl` / HTTP hard timeout / safety margin | Delivery CDD + Architecture | before Implementation | N/A — schedule not established | Yes |
| 出站幂等键映射与静态传输 Header（含 `Content-Type`） | Vendor Registry / Delivery CDD | before Implementation | N/A — schedule not established | No |
| sweeper cadence / leader election / batch scheduling | deployment / Architecture | before Implementation | N/A — schedule not established | No |
| Store 权威时钟来源、clock-health guard 与允许偏差 | Architecture: storage / deployment | before Implementation | N/A — schedule not established | Yes |
| `LISTEN/NOTIFY` worker wake · 多并发 worker 副本 · retention / 归档 · per-vendor SLO 看板 · vendor paused 原语 · 优先级 claim ordering | 各相关模块 CDD / v1+ | metric-triggered | N/A — schedule not established | No |

**已解决（从 Open Questions 移除）**：
- `notification_id` 形状：已在 Data Model 明确为 opaque identifier，具体形状由 Storage ADR 决定。
- hash-chain、GRANT INSERT、显式列名 UPDATE：属于实现建议 / 代码审查检查点，不是未决设计决策。

## Boundary Traceability

> 下列 `NS-BR-01..05` 为从 `module-index.md` Boundary Review Notes 的 notification-store 汇总 bullet
> 提取的**局部可追踪义务**（per 计划 0.2：不重写历史——索引中"携入笔记（8）"及六个汇总 bullet 原样保留；
> 全局统一编号须在找到原始 TD 证据后另作文档修正，不属于本 CDD 作者流程）。

| ID | 义务 | 正文落点 | AC |
|---|---|---|---|
| **NS-BR-01** | transition-request 操作签名 + Store 拒绝语义 | Detailed Design → States and Transitions | STATE-01..17（含 04a/04b）, LEASE-02..04, LEASE-06..10, SEC-05..08, ATT-11, NSBR-05c |
| **NS-BR-02** | attempt history 归 Store + 逻辑 `append_attempt` 原子 | Core Spec D + Data Model (DeliveryAttempt) | ATT-01..13, HIST-01..03, ATOM-03, NSBR-05d |
| **NS-BR-03** | stale in-flight / expired-lease 状态恢复 | Core Spec E + States (recovery) + Edge Cases | ATT-06, ATT-10, LEASE-03, LEASE-07, LEASE-09..10 |
| **NS-BR-04** | `caller_id` 服务端产生的不透明已验证输入；外部自报字段拒绝 | Interactions (`ValidatedIntake` seam) + Integration | INTAKE-05, INTAKE-05b, SEC-01..04, STATE-09 |
| **NS-BR-05** | 四逻辑子职责命名 + 边界 | Detailed Design → Logical Responsibilities | NSBR-05a..d（coverage mapping 项，非独立 AC） |

五项义务均有正文落点 + 可追踪 AC（见 §Acceptance Criteria 的 NS-BR 覆盖矩阵）。
