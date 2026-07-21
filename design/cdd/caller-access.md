# Caller Access

> **Status**: Approved — independent lean re-review; external Store/VR J3 gate closed 2026-07-20
> **Module**: Caller Access（Core · Layer 0）
> **Source**: `product-concept.md`、`module-index.md`、T0 BL-02 / BL-05
> **Scope budget**: ≤250 lines / ≤15 acceptance criteria
> **Last Updated**: 2026-07-20

## Overview

Caller Access 是外部请求进入通知服务的信任边界。它认证内部 API Key，由服务端记录推导
`principal_id`、`principal_kind`、vendor scope 与 capability，并执行授权和调用方级限流。
它只回答“这个主体能否执行这个动作或引用这个 `vendor_id`”，不判断 vendor 是否存在或 active，
不持久化通知，也不拥有投递、死信或重放状态。

## User Promise

对每个内部 API 请求，Caller Access 只接受有效凭证，并由服务端认证记录推导 `caller_id` 与权限
范围；调用方不能通过 Header / Body 自报身份，也不能访问凭证未授权的 `vendor_id` 或操作员动作。
该承诺只覆盖认证与授权边界，不承诺通知已持久化或送达。

## Detailed Design

### Core Specification

1. 统一凭证注册表保存 `PrincipalRecord` 与其 `AccessKeyRecord`；`caller` / `operator` 的 kind、
   scope、capability 只在 principal 上定义一次。同一 `principal_id` 全局绑定唯一 kind；
   `worker`、`system`、`delivery` 使用内部身份，不能通过外部 API Key 冒充。
2. `authenticate(api_key, operation)` 返回 `CallerPrincipal`、`OperatorPrincipal` 或去敏拒绝。
   原始 key 仅参与验证，不能进入 URL、日志、错误、指标或下游上下文。
3. `authorize_vendor(caller_principal, vendor_id)` 只校验 key→vendor scope；它不查询 Vendor
   Registry。scope 外与 vendor 不存在/disabled 的外部结果最终统一为 `404 VendorUnavailable`。
4. `authorize_operator(operator_principal, action, vendor_scope)` 按闭合 capability 矩阵授权。
5. `apply_rate_limit(principal_id, operation_class)` 在调用 Vendor Registry 或 Notification Store
   前执行；同一 principal 的多把 key 共享额度。
6. ingress composition 依次执行 Caller Access scope 授权、Vendor Registry active 检查，再构造
   `ValidatedIntake={caller_id,vendor_id,payload,idempotency_key}`。Caller Access 不计算
   `request_fingerprint`。
7. `issue_key` / `rotate_key` / `revoke_key` 仅允许具有 `manage_access_keys` 且
   `managed_principal_scope` 包含目标 principal 的 operator；管理 scope 不进入下游 ActorContext。
   明文只在已确认提交的 issue/rotate 成功响应中返回一次；rotate 不改变 principal 属性。
8. 每个 principal 最多两把 active key；并发 issue/rotate 原子仲裁，越界败方为
   `active-key-limit`。提交结果未知时不返回明文；调用方按预先返回/关联的 `key_id` 查询状态，
   若该 key 已 active 但明文丢失，只能 revoke 后重新签发。revoke 不可逆且提交后立即生效。
9. key lifecycle 成功、拒绝和结果未知只产生去敏安全事件；原始 key、verifier、payload 与完整
   scope/capability 不进入事件。本 CDD 不要求独立持久审计表。

### Authorization Matrix

| Principal kind | Operation | Required capability | Scope |
|---|---|---|---|
| caller | submit notification | `submit_notification` | target `vendor_id` |
| operator | query notifications | `read_notifications` | effective vendor scope |
| operator | preview replay | `replay_preview` | effective vendor scope |
| operator | execute replay | `replay_execute` | effective vendor scope |
| operator | batch replay | `replay_execute` + `replay_batch` | effective vendor scope |
| operator | key administration | `manage_access_keys` | target in `managed_principal_scope` |

未列出的 kind × operation × capability 组合一律拒绝。外部请求自报的 identity、kind、scope、
capability 或“已验证”标记属于未知/禁止字段，不得覆盖服务端事实。

### States and Transitions

| State | Allowed transition | Result |
|---|---|---|
| absent | `issue` | 新 key 进入 `active`；已确认提交后明文只返回一次 |
| `active` | `rotate` | 新 key 进入 `active`；旧 key 保持 active，直至显式 revoke |
| `active` | `revoke` | 进入终态 `revoked` |
| `revoked` | any lifecycle command | 拒绝；不可恢复 |

active-key 上限检查与 key 创建属于同一权威操作。rotation 不重置限流额度。已确认失败零写入；
提交结果未知按 Core Specification 第 8 条收敛。

### Interactions with Other Modules

| Consumer / provider | Contract | Boundary |
|---|---|---|
| ingress composition | `CallerPrincipal` + vendor authorization | 再调用 VR active 检查；CA 不判断 vendor 状态 |
| Vendor Registry | `kind=ingress`、目标 singleton vendor scope、仅 `vendor:read-active` | 不透传 key id 或其他 capability |
| Operations query / preview | Store `kind=operator`、收窄 vendor scope、仅 `read_notifications` | 每请求重新认证/授权 |
| Operations single execute | Store `kind=operator`、收窄 vendor scope、仅 `replay` | 只由 `replay_execute` 衰减生成 |
| Operations batch execute | 同上；每项仅 `replay` | 还须先通过 `replay_batch` |

可信 composition 只能删除 capability、收窄 scope 和改变为目标模块规定的 context kind；不能把
Caller/Operator principal 原样透传，也不能构造跨 VR/Store 的通用超级上下文。

## Data Model

### PrincipalRecord（持久逻辑实体）

| Field | Type | Required | Constraint |
|---|---|---|---|
| `principal_id` | string | Yes | 全局唯一；永不跨 kind 复用 |
| `principal_kind` | enum | Yes | `caller` / `operator`；创建后不可变 |
| `vendor_scope` | set | Yes | 有界、服务端管理 |
| `capabilities` | set | Yes | 闭合集、最小权限 |
| `managed_principal_scope` | set | operator only | 仅 key administration 使用；不下传 |

### AccessKeyRecord（持久逻辑实体）

| Field | Type | Required | Constraint |
|---|---|---|---|
| `key_id` | string | Yes | 全局唯一、可记录 |
| `secret_hash` | opaque verifier | Yes | 不可逆；明文不持久化 |
| `principal_id` | string | Yes | rotation 前后稳定 |
| `status` | enum | Yes | `active` / `revoked` |
| `created_at` / `revoked_at` | datetime | Yes / No | 服务端时间 |

关系：key 只引用 principal；认证时从同一 `PrincipalRecord` 推导 kind/scope/capability，禁止每把
key 复制出可漂移的授权事实。一个 principal 最多两条 active key。物理 schema、hash 算法、索引和
密钥生成器属于 Architecture。

### Principal Projections（短生命周期）

- `CallerPrincipal={principal_id as caller_id,key_id,vendor_scope,capabilities}`
- `OperatorPrincipal={principal_id as actor_id,key_id,vendor_scope,capabilities,managed_principal_scope}`

投影不接受外部字段回填。`key_id` 只用于当前边界审计，不进入 VR/Store ActorContext。

## Edge Cases

- **If key 缺失、畸形、未知或 revoked**：统一 `401 Unauthenticated`，不调用下游。
- **If caller 引用 scope 外 vendor**：返回 `404 VendorUnavailable`，不查询 VR。
- **If VR 返回 inactive/unknown**：composition 返回同一 `404 VendorUnavailable`，不调用 Store。
- **If key kind 与 operation 不匹配**：返回 `403 Forbidden`。
- **If rate limit 超限**：返回 `429` 与有界 `Retry-After`，不调用下游。
- **If access backend 无法完成权威验证**：返回可重试 `503`，不缓存为成功身份。
- **If rotation 试图改变 principal/kind/scope/capabilities**：拒绝整个命令。
- **If key-admin 目标不在 managed principal scope**：返回 `404` 形状，不泄露 principal 存在性。
- **If issue/rotate commit outcome unknown**：不返回 secret；按 `key_id` 查询，active 则 revoke，
  not-found 才可重新签发。
- **If revoke 与请求并发**：以认证判定所见的已提交状态为准；revoke 提交后的新认证零陈旧拒绝。

## Dependencies

- **硬设计依赖：无**（Layer 0）。
- **下游**：ingress composition、Operations Control。
- Vendor Registry 只提供 vendor active 事实；Notification Store 只接收可信 composition 产生的
  `ValidatedIntake` / operator context。Caller Access 不运行时读取二者来维护自身状态。

## Configuration

| Key | Default | Valid range / behavior |
|---|---:|---|
| `MAX_ACTIVE_KEYS_PER_PRINCIPAL` | `2` | 固定 MVP 上限；越界拒绝 |
| `CALLER_RATE_PER_MINUTE` | `60` | `1..100000` |
| `OPERATOR_READ_RATE_PER_MINUTE` | `60` | `1..10000` |
| `OPERATOR_MUTATION_RATE_PER_MINUTE` | `10` | `1..1000` |
| `RATE_LIMIT_RETRY_AFTER_MAX` | `60s` | `1s..300s` |

TLS、hash 算法、认证中间件、计数器实现和可信网络来源策略属于 Architecture。非法配置启动失败。

## Integration Requirements

- 外部身份通过受保护 Header 传递；具体 Header 名和 HTTP 路由在 Architecture / OpenAPI 中确定。
- 错误映射固定：认证失败 `401`；已认证但缺 capability `403`；scope 外或 vendor
  inactive/unknown `404 VendorUnavailable`；限流 `429`；权威验证不可用 `503`。
- 操作优先级固定为 credential authentication → kind/capability → scope → rate limit；失败后不执行
  后续步骤。key-admin 的 scope 外目标使用去敏 `404`。
- 调用方 envelope 只允许 `vendor_id` 与 base64 字符串 `payload_base64`，另有 `Idempotency-Key` Header；
  ingress composition 严格解码后才把原始 bytes 放入 `ValidatedIntake.payload`；自报
  `caller_id`、scope、URL、kind 或 capability 必须拒绝，不能静默忽略。
- Key 管理只定义内部行为契约；MVP 不设计 CLI 或管理 UI。

## UI Requirements

**N/A — internal headless service.** 本模块只有程序化认证与管理契约。

## Acceptance Criteria

- **CA-01 [API Contract]**：**GIVEN** active caller key，**WHEN** authenticate，**THEN** 返回服务端绑定的 `caller_id`、scope 和 capability，且不采用任何请求自报身份。
- **CA-02 [Security Negative]**：**GIVEN** key 缺失、畸形、未知或 revoked，**WHEN** 访问保护操作，**THEN** 返回同一 `401` 形状，不调用 VR/Store。
- **CA-03 [Security Negative]**：**GIVEN** 请求自报 identity/kind/scope/capability，**WHEN** 校验 envelope，**THEN** 拒绝且不构造 principal。
- **CA-04 [Security Negative]**：**GIVEN** caller scope 不含 vendor，**WHEN** authorize_vendor，**THEN** 返回 `404 VendorUnavailable`，不查询 VR。
- **CA-05 [Integration]**：**GIVEN** caller 授权且 VR active，**WHEN** composition 完成，**THEN** 仅构造既定 `ValidatedIntake` 与 singleton-scope ingress context。
- **CA-06 [Integration]**：**GIVEN** VR inactive/unknown，**WHEN** composition 处理，**THEN** 返回统一 `404` 且 Store 未被调用。
- **CA-07 [Security Negative]**：**GIVEN** operator 缺 action capability/scope，**WHEN**授权或衰减 context，**THEN**返回去敏拒绝；query/preview 只能得到 `read_notifications`，合法 execute 才能得到 Store `replay`。
- **CA-08 [Security Negative]**：**GIVEN** key 已签发，**WHEN**检查存储、日志、错误、指标与下游 context，**THEN**verifier/hash 仅在权威凭证存储中存在；其他位置无原始 secret 或 verifier。
- **CA-09 [Integration]**：**GIVEN** principal 只有一把 active key，**WHEN** rotate，**THEN**新 key 引用同一 principal，active key 数为 2 且授权事实仍只来自 PrincipalRecord。
- **CA-10 [Integration]**：**GIVEN** key revoke 已提交，**WHEN** 再认证，**THEN**立即统一 `401` 且不可恢复 active。
- **CA-11 [Concurrency]**：**GIVEN**并发 issue/rotate 竞争最后一个 active slot，**WHEN**提交，**THEN**恰一方成功，败方 `active-key-limit` 且 active key 总数不超过 2。
- **CA-12 [Integration]**：**GIVEN** 同 principal 的任一 key 已耗尽 operation bucket，**WHEN**继续请求，**THEN**返回 `429` 且不调用下游；rotation 不重置额度。
- **CA-13 [Integration]**：**GIVEN** access backend 无法权威验证，**WHEN**认证，**THEN**返回 `503`，不使用旧成功身份。
- **CA-14 [Security Negative]**：**GIVEN** 任一认证/授权/lifecycle/限流结果，**WHEN**记录事件，**THEN**事件不含原始 key、verifier、payload、完整 scope/capability 或 vendor 状态。
- **CA-15 [Integration]**：**GIVEN** issue/rotate 提交结果未知，**WHEN**调用方收敛，**THEN**响应不含 secret；按 key_id 查询后只允许“not-found→重新签发”或“active→revoke 后重新签发”。

### C1–C15 Applicability

| ID | Disposition | Locus |
|---|---|---|
| C1 | Applied | operation order、lifecycle、error mapping |
| C2 | Applied | security-event boundary |
| C3 | Applied | Principal/Key/Principal projections |
| C4 | N/A | 无多步数值 worked example |
| C5 | Applied | auth/capability/scope/rate gates |
| C6 | Applied | 401/403/404 去枚举 |
| C7 | Applied | atomic active-key limit |
| C8 | Applied | issuance outcome unknown |
| C9 | Applied | caller/operator closed kinds |
| C10 | Applied | server committed status/time |
| C11 | Applied | authorization matrix |
| C12 | N/A | 无 collection API |
| C13 | Applied | immutable principal + terminal revoke |
| C14 | Applied | vendor/key-admin scope |
| C15 | N/A | 无 collection API |

## Open Questions

无未决行为问题。具体 hash、存储、路由、认证中间件和限流计数器在 `/setup-engine` 后进入 Architecture。
