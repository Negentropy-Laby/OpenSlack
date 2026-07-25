# Operations Control

> **Status**: Approved — limited-exception independent lean re-review 2026-07-20
> **Module**: Operations Control（Operations · Layer 1）
> **Source**: `product-concept.md`、`module-index.md`、T0 BL-04
> **Scope budget**: ≤250 lines / ≤15 acceptance criteria
> **Last Updated**: 2026-07-20

## Overview

Operations Control 是内部操作员查询通知状态与人工重放 dead 通知的受守护入口。MVP 只定义内部
HTTP 行为契约；它组合 Caller Access 的操作员认证/授权与 Notification Store 的权威查询和
`transition_request(replay)`，不直接调用 Delivery，不管理 vendor，也不保存第二份状态或审计表。

## User Promise

获授权操作员可以在自身 vendor scope 内查看去敏通知状态，先零领域写入预览重放资格，再使用预览
所见的版本执行单条或最多 100 条显式重放。每个 execute 请求都重新认证；每条 item 由 Store 重新
校验 scope、状态与版本。并发变化只使该条安全跳过，不会扩大批次范围或回滚其他已成功条目。

## Detailed Design

### Core Specification

1. 每个请求先由 Caller Access `authenticate`，再按 `read_notifications`、`replay_preview`、
   `replay_execute`、`replay_batch` capability 与 vendor scope 授权。query/preview 只衰减为
   Store `kind=operator + read_notifications`；single execute 由 `replay_execute` 衰减为仅
   `replay`；batch 还须 `replay_batch`，每项仍只有 `replay`。不接受自报 actor/scope/capability。
   认证结果是单个请求的短生命周期快照；批次中途 revoke 影响后续请求，不重解释已认证请求。
2. 查询只代理 Store `query_outbox`、`query_notification`、`list_dead`、
   `list_attempt_history`；分页、排序、scope 与 cursor 语义以 Store CDD 为权威。
3. 四项查询使用闭合 allowlist，Store 新增字段不会自动透传：

| Query | Closed success envelope |
|---|---|
| `query_outbox` | `{pending_count,in_flight_count,delivered_count,dead_count,oldest_pending_age_seconds}` |
| `query_notification` | `{notification_id,state,version,attempt_count,delivery_cycle_started_at,replay_count,last_outcome_class?,last_error_code?,created_at,delivered_at?,dead_at?,replayed_at?}` |
| `list_dead` | `{items: DeadProjection[],next_cursor?}`；item=`{notification_id,vendor_id,state,version,attempt_count,replay_count,dead_at,dead_reason}` |
| `list_attempt_history` | `{items: AttemptProjection[],next_cursor?}`；item=`{attempt_seq,event_kind,result_kind?,outcome_class?,http_status?,error_code?,reason?,recorded_at}` |

payload、幂等材料、指纹、凭证、lease/holder、actor、error summary、replay reason/justification 与原始
供应商响应均不在 allowlist；请求不能通过字段选择器绕过。
4. `preview_replay(items, justification, operator_principal)` 接受 1..100 个显式且唯一的
   notification id。闭合响应为 `{items: ReplayPreviewResult[]}`，每项携带
   `input_index,notification_id`，且只能是
   `{outcome=eligible,current_state=dead,expected_version}` 或
   `{outcome=skipped,reason=not_found|not_dead,current_state?}`；`not_found` 不带 state/version，
   `not_dead` 只对已确认 scope 内既有通知返回 `current_state`。preview 零 Store/领域写入、零业务
   状态保留，允许去敏运行事件，返回值不是授权 token。
5. `execute_replay(items, justification, operator_principal)` 接受 1..100 个显式且唯一的
   `{notification_id, expected_version}`。每条仅调用 Store canonical
   `transition_request(replay, expected_state=dead, expected_version, justification,
   actor_context={kind=operator,actor_id=operator_principal.actor_id,
   vendor_scope=narrowed_vendor_scope,capabilities={replay}})`；不下传 key id、
   `managed_principal_scope` 或其他 capability。
6. execute 按输入顺序逐条 best-effort，闭合响应为
   `{succeeded: ReplaySucceeded[],skipped: ReplaySkipped[],failed: ReplayFailed[]}`：
   - succeeded item=`{input_index,notification_id,state=pending,version}`；
   - skipped item=`{input_index,notification_id,reason=not_found|stale_version|illegal_transition}`；
   - failed item=`{input_index,notification_id,reason=forbidden|unavailable|outcome_unknown}`。
   三个数组内均按 `input_index` 升序，输入项恰出现一次；不提供整批事务，不因某条失败回滚已成功条目。
7. execute 必须重新完成 Caller Access 认证/授权；即使刚完成 preview，也不得信任旧 principal、
   preview eligibility 或客户端声称的检查结果。

### Result Classification

| Store / composition result | Item outcome | Meaning |
|---|---|---|
| replay committed | `succeeded` | 返回 Store 新 state/version |
| `stale-version` / `illegal-transition` | `skipped:stale_version` / `skipped:illegal_transition` | 并发变化或已被重放；不重试写入 |
| scope 外 / 不存在 | `skipped:not_found` | 统一去敏，不暴露存在性 |
| capability revoked / forbidden | `failed:forbidden` | 当前请求授权失败；该条未写入 |
| Store 在调用前/确定回滚为 unavailable | `failed:unavailable` | 已知零写入；后续 item 仍独立尝试 |
| replay commit outcome unknown / response lost | `failed:outcome_unknown` | 不自动重放；操作员重新查询收敛 |
| malformed item / invalid justification | whole-request rejection | 调用 Store 前整批零写入 |

认证失败、批次 schema 错误和缺少批量 capability 属请求级失败；合法批次中的每条 Store 结果属于
item 级结果。Operations Control 不把 `failed` 自动转成后台任务。

### States and Transitions

本模块不拥有通知状态机。唯一允许的写意图是 `dead → pending`，实际合法性、版本递增、
delivery cycle 重置、replay history 与原子性完全由 Store `transition_request(replay)` 决定。
preview 不产生状态转换，也不承诺 execute 时仍 eligible。

### Interactions with Other Modules

| Module | Consumed contract | Boundary |
|---|---|---|
| Caller Access | `OperatorPrincipal` + action/scope authorization | 每请求重新认证；不缓存权限 |
| Notification Store | 四项 query + canonical replay transition | Store owns state/version/history |
| Delivery | none | replay 后由 Store pending 状态进入正常调度 |
| Vendor Registry / Observability | none | 不管理 vendor，不发布可靠性指标 |

## Data Model

**无持久领域实体。** `DeadProjection`、`AttemptProjection`、`ReplayPreviewResult`、
`ReplaySucceeded`、`ReplaySkipped`、`ReplayFailed` 与请求 item 都只是请求期 projection，
响应完成后丢弃。模块不保存 preview token、batch job、replay receipt、payload 副本或独立审计表；
Store append-only replay history 是领域审计真相。去敏运行日志不是领域状态或 replay receipt。

## Edge Cases

- **If preview 后状态或 version 改变**：execute 对该条返回 `skipped`，不覆盖新状态。
- **If 两个操作员并发执行同一 version**：Store OCC 只允许一个成功，另一条 `skipped`。
- **If execute 响应丢失**：不得盲目重发；重新查询 state/version 与 attempt history 收敛。
- **If 批次为空、超过 100、含重复 id、缺 version 或 justification 非法**：整批拒绝且零写入。
- **If 某条 scope 外**：该条只返回 `not-found`，后续合法条目继续。
- **If 中途 Store 不可用**：已提交条目不回滚；当前条目按 unavailable/outcome-unknown 精确分类，
  后续条目仍逐项尝试并保留各自结果。
- **If 调用方提供查询 filter 后要求“执行全部匹配项”**：拒绝；execute 只接受显式 id/version。

## Dependencies

- **硬依赖**：Caller Access、Notification Store。
- Caller Access 是请求身份/权限权威；Store 是通知状态、版本与 replay history 权威。
- 无 Delivery、Vendor Registry、Reliability Observability 运行时依赖。

## Configuration

| Key | Default | Invariant |
|---|---:|---|
| `REPLAY_BATCH_MAX` | `100` | 固定 MVP 上限，允许 `1..100` |
| `JUSTIFICATION_MIN_LENGTH` | Store contract | 不得弱于 Store |
| `JUSTIFICATION_MAX_LENGTH` | Store contract | 不得弱于 Store |

查询 page limit/cursor 直接沿用 Store 契约，不在本模块配置第二套值。非法配置启动失败。路由、
框架、中间件、超时和部署网络策略属于 Architecture。

## Integration Requirements

- MVP 只提供内部 HTTP API 行为；具体路径、OpenAPI、CLI 与管理 UI 均不在本 CDD。
- preview 请求包含显式 notification ids 与 justification；响应逐条给出当前 eligibility 与
  `expected_version`；闭合 envelope/原因按 Core Specification，且不返回 payload、幂等材料、
  指纹、凭证或 lease holder。
- execute 请求只能包含显式 `{notification_id, expected_version}`；不接受 query/filter/cursor
  作为写入目标，不接受“全部匹配”。
- 单条 execute 等价于一项批量 execute；批量响应保留输入关联并分别列出
  `succeeded` / `skipped` / `failed`，不能用单一 HTTP 成功码掩盖部分失败。
- 日志可以记录 operator id、notification id、去敏结果与 correlation id；原始 key、payload、
  justification 全文和敏感 Store 字段不得进入普通日志。

## UI Requirements

**N/A — MVP is internal HTTP only.** CLI 与管理 UI 明确排除。

## Acceptance Criteria

- **OC-01 [Security Negative]**：**GIVEN**缺失、无效或 revoked operator key，**WHEN**发起任一操作，**THEN**Caller Access 拒绝且 Store 未被调用。
- **OC-02 [Security Negative]**：**GIVEN**operator 缺目标 capability 或 vendor scope，**WHEN**查询/preview/execute，**THEN**返回去敏拒绝且不泄露目标存在性。
- **OC-03 [Integration]**：**GIVEN**已授权查询，**WHEN**读取四项 Store query，**THEN**结果遵循 Store 的 scope、分页、排序与 cursor 契约。
- **OC-04 [Security Negative]**：**GIVEN**任一查询或重放成功响应，**WHEN**检查 envelope 与 projection，**THEN**singleton query、两个 `{items,next_cursor?}` list、preview items 及 execute 三数组分别只含其闭合字段/原因；Store 新增字段不自动透传。
- **OC-05 [Integration]**：**GIVEN**1..100 个显式唯一 id，**WHEN**preview，**THEN**每个 input_index 恰返回 eligible(dead/expected_version) 或 skipped(not_found/not_dead) 一项，not_found 无 state/version，Store 状态/版本/历史不变且只允许去敏运行事件。
- **OC-06 [Security Negative]**：**GIVEN**preview 已成功但 key 或 capability 随后 revoked，**WHEN**新 execute 请求认证，**THEN**认证失败且零重放。
- **OC-07 [Integration]**：**GIVEN**dead 通知、匹配 version、有效 justification 与授权，**WHEN**execute，**THEN**唯一写调用为 canonical replay，Store context 恰含 operator kind、principal actor_id、收窄 vendor scope 与 `{replay}`，响应 succeeded item 只含 input_index/id/pending/version。
- **OC-08 [Concurrency]**：**GIVEN**preview 后通知 state/version 改变，**WHEN**execute 旧 version，**THEN**该条 skipped，且不覆盖当前状态。
- **OC-09 [Integration]**：**GIVEN**合法批次含成功、stale、not-found 与 Store failure，**WHEN**execute，**THEN**每个输入恰按闭合 reason 进入 succeeded/skipped/failed 之一，各数组按 input_index 升序，不回滚成功条目。
- **OC-10 [API Contract]**：**GIVEN**空批、超过 100、重复 id、缺 version 或非法 justification，**WHEN**校验，**THEN**整批在 Store 写调用前拒绝。
- **OC-11 [Security Negative]**：**GIVEN**query/filter/cursor 或“全部匹配”写请求，**WHEN**execute，**THEN**拒绝且不展开为 notification ids。
- **OC-12 [Integration]**：**GIVEN**replay 提交结果未知或响应丢失，**WHEN**处理失败，**THEN**标记 outcome-unknown 且不自动重写；操作员通过 Store 查询收敛。
- **OC-13 [API Contract]**：**GIVEN**运行时依赖与持久化审查，**WHEN**检查模块边界，**THEN**不存在 Delivery/VR 调用、自动重放、独立状态表或审计表。
- **OC-14 [Security Negative]**：**GIVEN**任一查询或重放结果，**WHEN**记录运行事件，**THEN**日志不含原始 key、payload、justification 全文或 allowlist 外字段。

### C1–C15 Applicability

| ID | Disposition | Locus |
|---|---|---|
| C1 | Applied | query/preview/execute contracts |
| C2 | Applied | Store history vs runtime log |
| C3 | Applied | closed projection allowlists |
| C4 | N/A | no numerical worked example |
| C5 | Applied | auth/scope/state/version gates |
| C6 | Applied | not-found de-enumeration |
| C7 | Applied | per-item OCC |
| C8 | Applied | unavailable vs outcome-unknown |
| C9 | Applied | operator-only actor |
| C10 | Applied | Store version/time authority |
| C11 | Applied | capability attenuation matrix |
| C12 | Applied | Store-owned bounded pagination |
| C13 | Applied | no owned mutable entity |
| C14 | Applied | narrowed vendor scope |
| C15 | Applied | Store cursor/order semantics |

## Open Questions

无未决行为问题。HTTP 路由、OpenAPI 形状、框架和运维网络边界在 `/setup-engine` 后确定。
