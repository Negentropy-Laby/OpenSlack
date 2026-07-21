# Vendor Registry

> **Status**: Approved — independent lean re-review #5; J1/J2/J3 + Batch 4B-NS closed
> **Source Concept**: `design/cdd/product-concept.md`
> **Module**: Vendor Registry（Foundation · Layer 0）
> **Method**: `/design-system vendor-registry --review lean` → bounded revision after initial lean review; G1–G7 bounded revision after re-review #1; H1–H8 bounded revision after re-review #2; I1–I6 bounded revision after re-review #3; J1/J2/J3-VR bounded revision after re-review #4; Batch 4B-NS complete
> **Review Mode**: lean（per-run；repo 级 `review-mode.txt` 未建；`CD-GDD-ALIGN` director gate 按 Lean 跳过并记录）
> **Created**: 2026-07-19

## Overview

> Vendor Registry 是 rc_wsman 中**供应商事实的单一权威**：它独占 vendor 存在性 / 禁用判定（VR-BR-01），
> 并拥有已批准端点的**策略数据**——canonical HTTPS endpoint target（服务端规范化；`hostname` / `port` /
> `transport_kind` 为**服务端派生字段**）、私网例外（`{hostname, port, cidr}`，authority 必须与 canonical URL 一致）、
> provider-neutral 凭证引用（`credential_ref` = opaque `{scheme, opaque_handle, reference_version?}`；**明文 secret 永不存储/
> 解析**）、传输 / 认证 Header 策略、以及端点驱动的出站幂等键映射（BL-05）。
>
> 它是只读为主 + 受守护管理员写的参考 / 配置模块，**不是**投递状态机。Delivery 每次 HTTP attempt
> 读取**权威 latest_active** 配置；per-attempt snapshot 已由 Delivery CDD 双向确认并为 binding。供应商被禁用后未发送的 attempt 停止；已发出的 HTTP 允许完成。
> 不可变 `config_version` 用于配置历史 / 审计，不用于 attempt 绑定。
>
> **边界（BL-05）**：VR 只拥有策略数据；运行时 SSRF 执行（DNS pinning / 不跟重定向 / 连接 / IP 校验）归
> Delivery。VR 不解析域名、不建立连接、不存储或解析明文 secret、不解析业务 payload、不认证调用方（归
> Caller Access）、**不进行 DNS / IP runtime 验证**。**Notification Store 运行时不查询 Vendor Registry**（AC-SEC-04）。消费方 CDD 均已
> Approved，跨模块读取契约为 binding。

## User Promise

**对三类内部消费方的契约：**

> **ingress / Delivery（读方）**：任何返回的 vendor 事实（存在性、active、端点策略、幂等键映射）来自
> **单一权威**且**权威零陈旧（read-after-commit consistency）**——`is_vendor_active` / `snapshot({latest_active})` 在成功写后立即可见，
> 无 bounded 陈旧窗口。`opaque_handle` 仅结构性出现于 `DeliveryConfigSnapshot`，且要求
> `vendor:snapshot-latest` **与** `vendor:read-credential-locator` 两项 capability；所有其他投影
> 结构性省略该字段——响应时不做动态删字段或脱敏。**明文 secret 永不**出现在任何读响应中。

> **Delivery（per-attempt 读方）**：Delivery 在每次出站 HTTP attempt 前调 `snapshot({latest_active})` 获取
> 权威快照——一次 attempt 一个，不绑定到整个投递周期。供应商被禁用后，未开始的 attempt 获得禁用信号并
> 停止；已发出的 HTTP 允许完成。`update_version` 或 `rotate` 后，下一个未开始 attempt 立即反映新配置。

> **管理员（写方）**：所有配置变更经 ActorContext + kind + scope + capability 鉴权，产生不可变审计 + 幂等
> receipt；处理顺序确定性（authn→schema→authz→receipt→state/OCC→atomic）。前置拒绝只产生去敏运行安全
> 事件；授权后业务拒绝写审计。失败与拒绝有稳定去敏的错误（不泄露存在性）。

**边界（本承诺不包含）：** 本承诺是"权威、一致、受控的供应商事实 + 明文 secret 保密 + 权威零陈旧（read-after-commit consistency）读取"。
它**不承诺**通知被供应商成功接收——最终送达是 Delivery 的职责。

## Detailed Design

> 行为契约。栈相关实现（SQL/DDL/ORM/KMS/HTTP client/连接池/迁移）记为 Architecture / ADR deferred。

### Core Specification

**A. ActorContext、scope 与 capability 矩阵（E4 + G1）**

```text
VendorScope =
  {kind: all}
  | {kind: vendor_ids, vendor_ids: non-empty set<vendor_id>}
  | {kind: owning_scopes, owning_scopes: non-empty set<string>}

ActorContext = {
  kind: ingress | delivery | operator | auditor | system,
  actor_id: opaque non-empty string,
  scope: VendorScope,
  capabilities: closed set<capability>
}
```

- capability 为闭合集：`vendor:read-active`、`vendor:snapshot-latest`、
  `vendor:read-credential-locator`、`vendor:read-history`、`vendor:read`、
  `vendor:read-audit`、`vendor:register`、`vendor:update`、`vendor:activate`、
  `vendor:disable`、`vendor:rotate-credential-ref`。未列 capability 一律无效。
- ActorContext 由可信服务端认证边界提供；`scope` 仅由该边界注入。
- 请求 body 不可自报 actor/scope/kind/capabilities；自报字段按闭合 schema **拒绝**（非"忽略"）。
- Actor kind 不隐含权限。每个受保护操作须同时满足：allowed kind + allowed scope kind + matching scope + exact capability。
- **kind × scope 类型允许矩阵（闭合）**：
  - `ingress`：仅 `vendor_ids`
  - `delivery`：`vendor_ids` | `all`
  - `operator` / `auditor`：`vendor_ids` | `owning_scopes` | `all`
  - `system`：三类皆可
- **scope 授权执行**：
  - `vendor_ids`：在 vendor lookup **之前**直接比较 `vendor_id ∈ scope.vendor_ids`。
  - `owning_scopes`：经**私有 owner-resolution**（服务端读取 `VendorRecord.owning_scope`，结果不向调用方暴露）判定 `record.owning_scope ∈ scope.owning_scopes`。
  - `all`：不限制目标。
- 跨 scope 或不存在 vendor 对受限调用方返回**相同安全结果**（不泄露 lifecycle / version）；未知 vendor 与跨 scope vendor 不可区分（C6）。

| Operation | Allowed kinds | Allowed scope kinds | Required capability |
|---|---|---|---|
| `is_vendor_active` | ingress, delivery, system | per kind matrix | `vendor:read-active` |
| `snapshot({latest_active})` | delivery, system | per kind matrix | `vendor:snapshot-latest` **AND** `vendor:read-credential-locator` |
| `snapshot({specific,N})` | operator, auditor, system | per kind matrix | `vendor:read-history` |
| `list_vendors` / `describe_vendor_state` | operator, auditor, system | per kind matrix | `vendor:read` |
| `list_endpoint_versions` | operator, auditor, system | per kind matrix | `vendor:read-history` |
| `list_admin_audit_events` | operator, auditor, system | per kind matrix | `vendor:read-audit` |
| `register_vendor` | operator, system | `owning_scopes` / `all` | `vendor:register` |
| `update_version` | operator, system | per kind matrix | `vendor:update` |
| `activate` | operator, system | per kind matrix | `vendor:activate` |
| `disable` | operator, system | per kind matrix | `vendor:disable` |
| `rotate_credential_ref` | operator, system | per kind matrix | `vendor:rotate-credential-ref` |

**唯一错误判定优先级**：

```text
ActorContext
→ closed schema / syntax
→ kind / capability
→ scope / scope-filter
→ cursor / limit（read only）或 receipt / fingerprint（admin only）
→ existence / version
→ business rule
```

同一请求命中多个条件时只返回上述顺序中的首个错误；不得返回候选错误集合。

**B. 读操作**
- `snapshot(vendor_id, version_ref, ActorContext) → DeliveryConfigSnapshot | HistoricalConfigSnapshot | ReadError`。
  `version_ref` 判别联合 `{latest_active}` | `{specific, config_version:N}`。
  `{latest_active}` = 权威零陈旧，要求两项 capability，返回 `DeliveryConfigSnapshot`；
  `{specific,N}` = 不可变历史，要求 `vendor:read-history`，返回 `HistoricalConfigSnapshot`。
  missing capability → `FORBIDDEN`；latest 的 not-found/disabled/out-of-scope →
  `VENDOR_INACTIVE_OR_UNKNOWN`；specific 的 missing/out-of-scope →
  `VENDOR_NOT_FOUND`，版本不存在 → `VERSION_NOT_FOUND`。
- `is_vendor_active(vendor_id, ActorContext) → {active: bool}`（ingress 用；权威；not-found ≡ disabled，
  out-of-scope 亦合并为 `{active:false}`；相同公开 status/schema/cache-policy；**零陈旧**）。
- `list_vendors(ActorContext, scope_filter?, cursor?, limit?) → {items: VendorListItem[], next_cursor?}`（**live keyset**：
  stable sort `(created_at ASC, vendor_id ASC)`；default 50, max 200；无 count 泄露）。
- `list_endpoint_versions(vendor_id, ActorContext, cursor?, limit?) →
  {items: EndpointVersionListItem[], next_cursor?, snapshot_max_config_version}`：
  按目标 `vendor_id` 授权（invalid/missing ActorContext 或 kind×scope 结构违例 → `INVALID_ACTOR_CONTEXT`（先于本判定）；ActorContext 有效但 operation 不允许该 kind 或缺 required capability → `FORBIDDEN`；目标不存在或不在 actor scope → 统一 `VENDOR_NOT_FOUND`；已授权 draft/active/disabled → 返回不可变版本列表，特权历史读取，lifecycle 不阻断——见读操作错误结果矩阵）；**不接受 `scope_filter`**（提交即 `INVALID_COMMAND`）。
  首次调用固定 `snapshot_max_config_version = current_config_version`；后续页 cursor 绑定该上限，只读 `config_version ≤ snapshot_max_config_version` 的不可变版本（keyset `config_version ASC`；50/200）。
- `list_admin_audit_events(ActorContext, scope_filter?, cursor?, limit?) →
  {items: AdminAuditListItem[], next_cursor?, snapshot_max_audit_seq}`：
  首次调用固定当前最大 `audit_seq`；空集固定为 `null`。后续页只遍历
  `audit_seq ≤ snapshot_max_audit_seq` 的冻结前缀（keyset
  `(audit_seq DESC,event_id DESC)`；50/200）；分页期间新增头部事件仅在下次遍历出现。
- `describe_vendor_state(vendor_id, ActorContext) → VendorStateSummary | ReadError`
  （特权；闭合 summary；**不嵌入**无界 version/audit 数组；invalid/missing ActorContext 或 kind×scope 结构违例 → `INVALID_ACTOR_CONTEXT`（先于本判定）；ActorContext 有效但 operation 不允许该 kind 或缺 required capability → `FORBIDDEN`；目标不存在或不在 actor scope → 统一 `VENDOR_NOT_FOUND`；已授权 draft/active/disabled → 返回 `VendorStateSummary`，特权状态读取，lifecycle 不阻断——见读操作错误结果矩阵）。
- `ScopeFilter` 只用于 `list_vendors` / `list_admin_audit_events`：非 `all` actor
  只能提交与自身 scope 同 kind 的子集；`all` actor 可省略或提交任一闭合 filter；
  跨 kind/扩权 → `FORBIDDEN_SCOPE_FILTER`。
- **Cursor**：opaque + tamper-evident，绑定 operation + effective scope + filter + sort direction + snapshot cap + last sort key。
  越界/跨操作/跨 scope/filter-mismatch/snapshot-cap-mismatch → `INVALID_CURSOR`；无效 limit → `INVALID_PAGE_LIMIT`。
- `list_vendors` 为 live：新行可能出现在后续页；可变 lifecycle 反映每页读时；不可变 sort key 防止行移动。
- 删除 `snapshot_at_epoch` / `view_epoch` / `view` 参数。

**读操作错误结果矩阵（J1，逐操作闭合）**

> 阶段判定（先于下表）：invalid/missing ActorContext，或违反 kind×scope 结构矩阵 → `INVALID_ACTOR_CONTEXT`；ActorContext 有效但 operation 不允许该 kind 或缺 required capability → `FORBIDDEN`。下表“operation 未授权”列仅指后者（ActorContext 已有效）。

| 操作 | operation 未授权（ActorContext 有效） | 目标不存在或不在 actor scope | 已授权且目标存在 |
|---|---|---|---|
| `is_vendor_active` | `FORBIDDEN` | `{active:false}`（合并；不区分） | `active`→`{active:true}`；`draft`/`disabled`→`{active:false}` |
| `snapshot({latest_active})` | `FORBIDDEN`（缺任一 capability） | `VENDOR_INACTIVE_OR_UNKNOWN`（合并） | `active`→`DeliveryConfigSnapshot`；`draft`/`disabled`→`VENDOR_INACTIVE_OR_UNKNOWN` |
| `snapshot({specific,N})` | `FORBIDDEN` | `VENDOR_NOT_FOUND`（含 `owning_scopes` scope rejection，VR-SCOPE-03） | `HistoricalConfigSnapshot`（任意 lifecycle；`N` 不存在→`VERSION_NOT_FOUND`） |
| `list_endpoint_versions` | `FORBIDDEN` | `VENDOR_NOT_FOUND` | `{items: EndpointVersionListItem[], next_cursor?, snapshot_max_config_version}`（任意 lifecycle；特权历史读取） |
| `describe_vendor_state` | `FORBIDDEN` | `VENDOR_NOT_FOUND` | `VendorStateSummary`（任意 lifecycle；特权状态读取） |
| `list_vendors` / `list_admin_audit_events` | `FORBIDDEN` | n/a（集合；scope 经 `ScopeFilter` 限定；扩权→`FORBIDDEN_SCOPE_FILTER`） | scope 内分页 item |

**C. 管理员写操作（G3 + G4）**

统一命令 envelope：

```text
AdminCommand = {
  operation,
  vendor_id,
  expected_record_revision,
  idempotency_key,
  body
}
```

闭合 `operation` × `body`（均需 ActorContext + kind + scope + capability；均即时生效）：

- `register`：仅 `operator|system` + scope=`owning_scopes|all`；`body = {owning_scope, initial_config}`；
  `owning_scopes` actor 的 `body.owning_scope` 必须落在其 scope 内；`expected_record_revision`
  **必须为 0**；→ VendorRecord（lifecycle=`draft`、`record_revision=1`、
  `current_config_version=1`、`owning_scope` 来自 body）+ EndpointVersion v1。
  `initial_config` = `{endpoint_target, method, transport_auth_headers, outbound_idempotency_mapping, endpoint_policy, auth_strategy, credential_ref}`（首版完整配置）；`method` 是闭合
  `ENDPOINT_METHOD_ALLOWLIST` 中的显式输入，不从 URL 推导。
- `update_version`：`body = {replacement_policy}`；**完整替换**非凭证配置（canonical target / HeaderRule / 幂等映射 / `endpoint_policy` / `auth_strategy`），**继承**当前 `credential_ref`；→ 新不可变 EndpointVersion N+1；bump `current_config_version` + `record_revision`。
  `replacement_policy` = `{endpoint_target, method, transport_auth_headers, outbound_idempotency_mapping, endpoint_policy, auth_strategy}`（**不含** `credential_ref`）；该命令完整替换 method，
  不存在隐藏默认或继承。
- `activate`：`body = {}`；→ `draft→active`（即时）；`record_revision++`；**不**新增 EndpointVersion。
- `disable`：`body = {reason}`；→ `disabled`（即时、单向前向）；`record_revision++`；**不触 EndpointVersion**；未开始 attempt 停止；已发出 HTTP 可完成。
- `rotate_credential_ref`：`body = {new_credential_ref}`；**只替换** credential reference，其余配置继承；→ 新 EndpointVersion + bump `current_config_version` + `record_revision`；**仅 draft/active**；disabled → `VENDOR_DISABLED_UPDATE_FORBIDDEN`。

**不存在**：partial-patch / merge 操作（update 一律全量替换，无 null-delete / 部分 patch）、`replace_credential_ref`（已删除）、hard-delete op、re-activate op、scheduling/`effective_at` 输入。

**Endpoint target 与配置结构（G2 + G3）**

调用方提交单一权威 URL；`hostname` / `port` / `transport_kind` 为**服务端派生**字段：

```text
EndpointTargetInput = {
  url,
  private_network_exception?
}

PrivateNetworkException = {
  hostname,
  port,
  cidr
}

CanonicalEndpointTarget = {
  canonical_url,
  hostname,
  port,
  transport_kind,
  cidr_exception?
}
```

服务端规范化规则：
- scheme 必须为 `https`（拒绝 `http`）。
- 拒绝 userinfo、fragment、wildcard hostname、IP literal，以及含 NUL/CR/LF 的 URL。
- `hostname` 规范化为精确 ASCII FQDN；`port` 缺省 443。
- 持久化 `canonical_url`；snapshot 中 `hostname` / `port` 必须由该 URL 派生。
- 私网例外 `PrivateNetworkException` 的 `hostname` / `port` 必须与 canonical URL authority 一致；`cidr` 必须为同地址族 canonical network CIDR（host bits 0），且与同地址族 `FORBIDDEN_CIDR_EXCEPTION_RANGES` 任一成员无地址交集、prefix length ≥ `MIN_CIDR_EXCEPTION_PREFIX_LENGTH`（见 VR-BL05-04/09、VR-CFG-15）。
- VR **不**执行 DNS / IP runtime 校验（归 Delivery）；URL parser / library 与完整 CIDR 算法 → Architecture / ADR。

Header 规则（判别联合）：

```text
HeaderRule =
  {kind: literal, name, value}
  | {kind: credential_field, name, credential_field}
```

- Header name 在任何校验/冲突比较前规范化为 ASCII lowercase；规范化后重复即拒绝。
- 所有 Header name 必须符合闭合 HTTP token、属于
  `EndpointPolicy.allowed_request_header_names` 且不属于
  `forbidden_request_header_names`。
- `literal`：仅允许非敏感传输 Header；`name` 还须属于
  `STATIC_HEADER_NAME_ALLOWLIST`；`value` 须满足 H7 长度/控制字符约束。
- `credential_field`：由 credential / auth strategy 在 Delivery 侧生成；name/selector
  必须与 configured credential profile 兼容，否则 `INVALID_ENDPOINT_POLICY`
  （Authorization / Cookie / Proxy-Authorization 等不允许 literal secret）。
- 凭证值不进 VR；仅保存 opaque selector。

出站幂等键映射（互斥判别联合）：

```text
OutboundIdempotencyMapping =
  {mode: none}
  | {mode: header, header_name}
  | {mode: body_field, field_name}
```

三种模式互斥。header 模式的 `header_name` 规范化后须属于 allowed、不属于
forbidden，且不得与 literal/credential/其他 mapping 重名；违例为
`INVALID_COMMAND`。body-field 模式在配置期校验 `field_name` 匹配 `[A-Za-z0-9_.-]{1,128}`（`.` 普通 key 字符）；运行时仅适用
JSON object payload；不适用时由 Delivery CDD 给出确定结果，禁止静默跳过。
具体注入行为已由 Delivery CDD 双向确认。VR 写入时校验
`1 <= endpoint_policy.max_request_body_bytes <= 262144`。

**D. 并发与失败（C7/C8）**
- 所有变更经 `expected_record_revision` OCC；单一败方 `EXPECTED_VERSION_MISMATCH`（响应只含 record_revision /
  lifecycle，**不含 last_writer actor**）。

**E. 幂等 receipt、AdminResult 与错误集（E7 + G4 + G5）**

```text
AdminResult = {
  operation,
  vendor_id,
  lifecycle,
  record_revision,
  current_config_version
}

AdminCommandReceipt = {
  receipt_id, actor_id, idempotency_key, command_fingerprint,
  operation, vendor_id, safe_result, committed_at
}
```

- `AdminCommandReceipt.safe_result` 类型 = `AdminResult`（闭合；原未定义的内嵌 result 子字段已移除）；不含 credential reference / endpoint policy / secret / caller-supplied value。
- PK：独立 `receipt_id`；保留 `(actor_id, idempotency_key)` unique 约束。
- `command_fingerprint` = hash of `(operation, vendor_id, expected_record_revision, canonicalized_closed_request_body)`。
  精确 canonical hashing 算法 → Architecture deferred；字段集 + 服务端计算 + 稳定相等 + 不可变持久 = CDD binding。
- `AdminCommandError` 为闭合 13 项：`INVALID_ACTOR_CONTEXT`、`INVALID_COMMAND`、
  `FORBIDDEN`、`VENDOR_ID_UNAVAILABLE`、`VENDOR_NOT_FOUND`、
  `EXPECTED_VERSION_MISMATCH`、`INVALID_TRANSITION`、
  `VENDOR_DISABLED_UPDATE_FORBIDDEN`、`INVALID_ENDPOINT_POLICY`、
  `INVALID_CREDENTIAL_REF`、`IDEMPOTENCY_CONFLICT`、`COMMIT_ROLLED_BACK`、
  `COMMIT_OUTCOME_UNKNOWN`。
- `ReadError` 为闭合 9 项：`INVALID_ACTOR_CONTEXT`、`INVALID_COMMAND`、`FORBIDDEN`、
  `FORBIDDEN_SCOPE_FILTER`、`VENDOR_INACTIVE_OR_UNKNOWN`、`VENDOR_NOT_FOUND`、
  `VERSION_NOT_FOUND`、`INVALID_CURSOR`、`INVALID_PAGE_LIMIT`。读路径不设独立的
  disabled 错误名；latest disabled 合并为 `VENDOR_INACTIVE_OR_UNKNOWN`。
- register 的任意已占用/tombstoned/其他 owner 冲突外部统一
  `VENDOR_ID_UNAVAILABLE`；详细冲突原因不进入响应、`AdminAuditEvent` 或可关联
  runtime event，最多形成无 vendor/owner/lifecycle 标识的聚合指标。
- **重放裁决（G4）**：成功 receipt 重放**先重新鉴权**（authn + kind + capability + scope）；权限 / scope 已撤销 → `FORBIDDEN`（不返回旧 `safe_result`、不泄露存在性）。授权仍有效 + 同 `(actor_id, idempotency_key)` + 同 `command_fingerprint` → 返回原 `safe_result`，不重新应用 state/version/audit/receipt writes。
- 同 key + 不同 fingerprint → `IDEMPOTENCY_CONFLICT`。
- Receipt **MVP 不自动过期**；retention 变更须经 metric-triggered 设计决定。
- **拒绝的命令不创建 receipt**（允许同 key 纠正后盲重试）。

**F. 处理顺序与审计副作用（E8）**

```text
authenticate ActorContext
→ closed-schema and syntax validation
→ kind + capability validation
→ scope authorization
   - vendor_ids: direct membership test before any vendor lookup
   - owning_scopes: private owner-resolution; no externally observable existence result
→ cursor / limit validation（read only）
   OR idempotency receipt lookup and fingerprint comparison（admin only）
→ vendor state / OCC / lifecycle / endpoint-policy checks
→ atomic mutation
```

Receipt lookup 在 scope authorization **之后**、state/OCC **之前**：成功命令重放仍返回原 `AdminResult`（即使后续 revision 已推进）；但若 actor 的权限 / scope 已被撤销，replay **先返回 `FORBIDDEN`**——不返回旧 `safe_result`、不泄露存在性。

| Outcome stage | Persistent mutation | AdminAuditEvent | AdminCommandReceipt | Runtime security event |
|---|---:|---:|---:|---:|
| invalid/missing ActorContext | no | no | no | yes, sanitized |
| schema/syntax rejection | no | no | no | yes, sanitized |
| kind/capability/scope rejection（含 `vendor_ids` 查库前 membership 拒绝、`owning_scopes` owner-resolution 失败/目标不存在、same-key fingerprint 冲突） | no | no | no | yes, sanitized（不含 vendor/owner/lifecycle） |
| same key, different fingerprint | no | no | no | yes, sanitized |
| authorized business rejection（已授权请求的目标确实不存在[`vendor_ids`/`all` 的 `VENDOR_NOT_FOUND`]/OCC/lifecycle/policy/credential；register ID 冲突 `VENDOR_ID_UNAVAILABLE`） | no | one `rejected`（reject_reason ∈ 7） | no | optional derived signal |
| success | atomic | one `success`, same tx | one, same tx | no |
| confirmed rollback (`COMMIT_ROLLED_BACK`) | no durable mutation | no | no | one sanitized `operation_failed` |
| commit outcome unknown (`COMMIT_OUTCOME_UNKNOWN`) | unknown until same-key convergence | no new durable-audit guarantee in response path | no unconfirmed receipt returned | one sanitized `operation_failed` |

Success 原子单元：`VendorRecord mutation + optional EndpointVersion append + AdminAuditEvent(success) + AdminCommandReceipt`。
`AdminAuditEvent` 保留 sanitized request digest；成功 audit 可引用 receipt ID；**`command_fingerprint` 仅持久化于 `AdminCommandReceipt`——永不返回、不记录进日志、不复制进 `AdminAuditEvent`**（spec/AC 中可提及该字段本身）。
Runtime security events 是 observability 契约，**非** VR 持久实体。

`COMMIT_ROLLED_BACK` 表示 VR 已确认持久化事务未提交：无 VendorRecord /
EndpointVersion / AdminAuditEvent / AdminCommandReceipt 副作用，同 key 重试按新命令
正常处理。`COMMIT_OUTCOME_UNKNOWN` 的首次响应不携带未经确认的 `AdminResult`；
仅通过同 key 重试收敛，最终最多一条 receipt。

**G. 存在性防泄露（C6）**
- `is_vendor_active` 对 not-found / disabled / out-of-scope 合并为 `{active:false}`；
  `snapshot({latest_active})` 对三者合并为 `VENDOR_INACTIVE_OR_UNKNOWN`
  （相同公开 status / response schema / error category / cache policy，授权先于结果构造）。
- **零陈旧**：`is_vendor_active` / `snapshot({latest_active})` 在成功写后立即可见——**无 bounded 陈旧窗口**。
  缓存允许仅当通过 proven synchronous invalidation 保持同一权威行为。
- 不可变 `snapshot({specific,N})` 可缓存（内容不变）。
- **删除** `CACHE_STALENESS_MAX_SECONDS`（不适用权威 active/latest 读路径）。
- 不暴露 vendor 状态/版本/total count/特权遥测。不声称统计时延不可区分。
- (auth → scope → existence → construct)

**H. BL-05 边界（策略数据 vs 运行时执行）**
- VR 只存策略数据；不做 DNS 解析/连接/IP 校验（归 Delivery）。
- config-write 时拒绝已知危险值（metadata IP、广 CIDR、loopback、disallowed port、wildcard hostname）为 defense-in-depth。
- Credential reference 校验通过 **configured closed scheme/profile validator**（确定性）；删除未定义的 `secret-pattern` 谓词。

### States and Transitions

**状态集合**：`draft`、`active`、`disabled`。（EndpointVersion 无状态机——append-only 不可变产物。）

**合法转换**（闭合集，C5 total；均即时生效）：

| From | To | 触发 | record_revision | config_version |
|---|---|---|---|---|
| (none) | `draft` | `register` | → 1 | → 1（新建 EndpointVersion v1） |
| `draft` | `active` | `activate` | ++ | 不变（不 append EndpointVersion） |
| `draft` | `disabled` | `disable` | ++ | 不变 |
| `active` | `disabled` | `disable` | ++ | 不变 |

**非法路径**（一律 `INVALID_TRANSITION`）：`active→draft`、`disabled→active`（单向前向）、`disabled→draft`、`disabled→*`。

**并发（C7）**：经 `record_revision` OCC；单一败方 `EXPECTED_VERSION_MISMATCH`（不含 last_writer actor）。

**禁用与 in-flight 投递**：`disable` 即时生效，未开始的 attempt 下次 `snapshot({latest_active})` 获得禁用信号；
已发出的 HTTP 允许完成（Delivery 记录其结果）。

### Interactions with Other Modules

> ingress 与 Delivery CDD 均已 Approved；所有跨模块契约已双向确认并为 binding。

- **ingress composition（读）**：`is_vendor_active(vendor_id)` 于 intake 验 active（**VR 为供应商存在性/active 状态的单一权威**；权威、零陈旧；unknown/draft/disabled/out-of-scope 合并为 `{active:false}`，不区分——此合并语义为权威，下游必须遵从）。
- **Delivery（读 + per-attempt）**：每次出站 HTTP attempt 前调 `snapshot(vendor_id, {latest_active})` 获取权威快照——
  一次 attempt 一个，不绑定投递周期；同时要求 `vendor:snapshot-latest` 与
  `vendor:read-credential-locator`，返回 `DeliveryConfigSnapshot`。从快照取 endpoint /
  opaque credential_ref / transport-auth headers / 幂等键映射。
  禁用后未开始 attempt 停止；已发出 HTTP 可完成。
- **Notification Store**：**运行时不查询 VR**（AC-SEC-04 硬边界）。
- **下游契约校正（J3，Batch 4B-NS complete）**：Notification Store 的两处原暂定
  wording 已服从 VR 权威合并语义——**全部非 active 或越权负向场景（unknown / draft /
  disabled / out-of-scope）统一合并为单一负向结果，不区分原因**；未改 NS 状态机、数据模型或
  79 条 AC 数量。ingress composition 只能产生单一、不泄露存在性的结果；公开 HTTP 结果由
  Caller Access 契约固定为 `404 VendorUnavailable`，VR 不另定义外部错误名。
- **Vendor Registry 独占程序化管理 API**：register / update / activate / disable / rotate + 审计读。
  **Operations Control 不拥有供应商管理职责**（OC 的 module-index 职责仍为通知查询 + 人工重放）。

### Logical Responsibilities

> 责任分区（responsibility partitions），非预设类/包/文件。

- **VendorRecordStore** — VendorRecord（存在性 + lifecycle + `record_revision` OCC + `current_config_version`）。
- **EndpointVersionStore** — append-only 不可变 EndpointVersion（含 opaque credential_ref）。write-once / 不软删 / 不硬删。
- **AdminCommandReceiptStore** — immutable write-once receipts。
- **PolicyReadModel（读侧组合）** — 使用闭合结构装配
  `DeliveryConfigSnapshot` / `HistoricalConfigSnapshot` / list items / summary；
  不解析 DNS / 连接。`opaque_handle` 只结构性存在于 capability-gated 的
  `DeliveryConfigSnapshot`，不做响应时动态删字段。
- **VendorLifecycleGuard（写侧组合）** — 转换校验（C5）、capability/scope（C11）、OCC（C7）、receipt lookup（E7/E8）、审计 + 安全事件。

## Data Model

> 逻辑模型（stack-neutral）。不写 SQL/DDL/ORM/KMS/连接池/迁移——Architecture / ADR deferred。

### VendorRecord

| 字段 | 类型 | 必填 | 约束 / 不变量 |
|---|---|---|---|
| `vendor_id` | string | Y | `^[a-z0-9-]{1,64}$`；闭合 charset；全局唯一 + 不可重用 |
| `lifecycle` | enum | Y | `draft`/`active`/`disabled`；仅经状态机变更 |
| `record_revision` | int | Y | ≥1，单调；每次成功 admin mutation +1；OCC token |
| `current_config_version` | int | Y | ≥1；指向最新 EndpointVersion |
| `owning_scope` | string | Y | `[a-z0-9._-]{1,128}`（lowercase；uppercase 拒绝，不 case-fold）；来自 `register.body.owning_scope`；register 后不可变（见 VR-INTAKE-10） |
| `created_at` / `activated_at` / `disabled_at` | ts | N | 服务端时钟；created 不可变 |
| `disabled_reason` | string | N | lifecycle=disabled 时必填 |

查询键：`vendor_id`(PK)、`lifecycle`、`owning_scope`、`(lifecycle, created_at)`。

### EndpointVersion（append-only 不可变）

| 字段 | 类型 | 必填 | 约束 / 不变量 |
|---|---|---|---|
| `(vendor_id, config_version)` | composite PK | Y | 不可变；write-once |
| `config_schema_version` | int | Y | 本版本写入时的 endpoint config schema 版本；不可变 |
| `canonical_url` / `method` | string/enum | Y | 服务端规范化后的权威 HTTPS URL；method ∈ configured allowlist |
| `hostname` / `port` | string/int | Y | **服务端派生**自 `canonical_url`；精确 ASCII FQDN（无 wildcard / IP literal）；port ∈ configured allowlist |
| `transport_kind` | enum | Y | **服务端派生**（唯一规则：`https_private` iff 带 `PrivateNetworkException`/cidr_exception，否则 `https_public`，见 VR-URL-04） |
| `cidr_exception` | `{hostname,port,cidr}` | N | 私网例外；authority 必须与 `canonical_url` 一致；cidr ∉ `FORBIDDEN_CIDR_EXCEPTION_RANGES` |
| `transport_auth_headers` | list<HeaderRule> | Y | 闭合判别联合（literal / credential_field） |
| `outbound_idempotency_mapping` | OutboundIdempotencyMapping | Y | 闭合判别联合（none / header / body_field） |
| `endpoint_policy` | EndpointPolicy | Y | 闭合子 schema（下） |
| `auth_strategy` | enum | Y | `bearer`/`hmac`/`mTLS`/`aws_sig_v4`/`custom` |
| `credential_ref` | CredentialRef | Y | opaque 字段组 |
| `created_at` / `created_by_actor` | ts/string | Y | 服务端时钟 / actor_id |

**EndpointPolicy**：`allowed_request_header_names`、`forbidden_request_header_names`（各 duplicate-free lowercase ASCII HTTP token set，成员 1–128 bytes，单集 0–32，交集空）、`max_request_body_bytes`（1–262144）。未知字段拒绝。`response_header_allowlist` 已删除（MVP 无消费方）。（retry policy + outbound timeout 归 Delivery。）`transport_auth_headers` 为 `list<HeaderRule>`（在 EndpointVersion，非 EndpointPolicy set）。

**CredentialRef（opaque）**：`scheme`（∈ configured credential-scheme allowlist；拒绝 inline/plaintext/data/http）、
`opaque_handle`（敏感 locator；仅 Delivery-snapshot capability 可见）、`reference_version?`。

write-once / 不更新 / 不删除。**删除** `superseded_by_version`（旧版本永不变更）。

### Snapshot projections（不可变读值，E6 + H3）

```text
DeliveryConfigSnapshot = {
  projection_schema: delivery-v1,
  vendor_id, config_version, config_schema_version,
  canonical_url, method, hostname, port, transport_kind, cidr_exception?,
  transport_auth_headers, outbound_idempotency_mapping,
  endpoint_policy, auth_strategy, credential_ref
}

HistoricalConfigSnapshot = {
  projection_schema: historical-v1,
  vendor_id, config_version, config_schema_version,
  canonical_url, method, hostname, port, transport_kind, cidr_exception?,
  transport_auth_headers, outbound_idempotency_mapping,
  endpoint_policy, auth_strategy,
  credential_descriptor: {scheme, reference_version?}
}
```

两种 snapshot 都不含 lifecycle 或时间戳字段。`projection_schema` 为闭合枚举
`delivery-v1|historical-v1`；对同一 `(vendor_id, config_version,
projection_schema)` 重复读取**字段级语义相等**（canonical wire serialization 属 Architecture deferred；底层 EndpointVersion 字节不可变）。**字段级语义相等定义**：record 递归比较字段；set 顺序无关；list 顺序相关；absent 与 null 不等（除非 schema 明确等价）。`config_schema_version` 与配置字段一对一
来自 EndpointVersion。只有 `DeliveryConfigSnapshot` 含完整 opaque
`CredentialRef`（可含 `opaque_handle`）；`HistoricalConfigSnapshot` 结构性省略
locator。明文 secret 永不出现。

### Query projections and ScopeFilter（H5）

```text
ScopeFilter =
  {kind: vendor_ids, vendor_ids: non-empty set<vendor_id>}
  | {kind: owning_scopes, owning_scopes: non-empty set<string>}

VendorListItem = {
  vendor_id, lifecycle, owning_scope, record_revision,
  current_config_version, created_at
}

EndpointVersionListItem = {
  vendor_id, config_version, config_schema_version,
  canonical_url, method, transport_kind, auth_strategy,
  credential_descriptor: {scheme, reference_version?},
  created_at, created_by_actor
}

AdminAuditListItem = {
  event_id, audit_seq, vendor_id, actor_id, authorization_basis,
  operation, outcome, expected_record_revision_before?,
  record_revision_after?, sanitized_request_digest, receipt_id?,
  reject_reason?, occurred_at
}

VendorStateSummary = {
  vendor_id, lifecycle, owning_scope, record_revision,
  current_config_version, config_version_count, audit_event_count,
  created_at, activated_at?, disabled_at?, disabled_reason?
}
```

list items / summary / primitive `is_vendor_active` 不含 `projection_schema`：
snapshot 的字段级语义稳定来自 projection schema（wire 字节稳定性属 Architecture），EndpointVersion list 的字段来自不可变
版本，audit list 来自 append-only event，VendorListItem/summary/active primitive
则明确是 live read。

### AdminCommandReceipt（immutable write-once，E7）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `receipt_id` | string | Y | PK（独立） |
| `(actor_id, idempotency_key)` | composite | Y | unique 约束 |
| `command_fingerprint` | hash | Y | hash of (operation, vendor_id, expected_record_revision, canonicalized body) |
| `operation` / `vendor_id` | string | Y | |
| `safe_result` | AdminResult | Y | 闭合 {operation, vendor_id, lifecycle, record_revision, current_config_version}；无 credential/policy/secret |
| `committed_at` | ts | Y | 服务端时钟 |

write-once / MVP 不自动过期。拒绝的命令不创建 receipt。

### AdminAuditEvent（append-only）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `event_id` | string | Y | PK |
| `audit_seq` | int | Y | 全局唯一、严格递增（可有数值间隙）；用于倒序分页 snapshot 上限 |
| `vendor_id` / `actor_id` | string | Y | |
| `authorization_basis` | AuthorizationBasis | Y | 闭合 `{all}` / `{vendor_id}` / `{owning_scope}`；仅记本次授权依据，不复制完整 scope 集 |
| `operation` | enum | Y | `register`/`update_version`/`activate`/`disable`/`rotate_credential_ref` |
| `outcome` | enum | Y | `success`/`rejected`（closed；runtime security event 为非持久 observability，**非** AdminAuditEvent 派生视图） |
| `expected_record_revision_before` / `record_revision_after` | int | N | |
| `sanitized_request_digest` | hash | Y | 已脱敏请求哈希；credential_ref 只留 opaque reference id |
| `receipt_id` | ref | N | 成功时指向 `AdminCommandReceipt.receipt_id` |
| `reject_reason` | enum | N（outcome=rejected 时必填） | 闭合 7：`VENDOR_ID_UNAVAILABLE`/`VENDOR_NOT_FOUND`/`EXPECTED_VERSION_MISMATCH`/`INVALID_TRANSITION`/`VENDOR_DISABLED_UPDATE_FORBIDDEN`/`INVALID_ENDPOINT_POLICY`/`INVALID_CREDENTIAL_REF`（见 VR-AUDIT-08）；前置拒绝不写 AdminAuditEvent（VR-AUDIT-06）。 |
| `occurred_at` | ts | Y | 服务端时钟 |

**AuthorizationBasis（G1 + G5）**：

```text
AuthorizationBasis =
  {kind: all}
  | {kind: vendor_id, vendor_id}
  | {kind: owning_scope, owning_scope}
```

仅记录本次授权所依据的**具体** basis（一个 `vendor_id`、或一个 `owning_scope`、或 `all`），不复制 ActorContext 的完整 scope 集合；kind 与 `VendorScope` 三类一一对应。

write-once / 永不编辑 / 脱敏在写入时。**删除** `last_audit_event_id`（audit 用独立 bounded index）。

### CDD 级不变量（非 SQL）

1. **vendor_id 不可重用**。
2. **EndpointVersion + AdminCommandReceipt write-once**；schema 自描述（C3）。
3. **双版本单调**：`record_revision` 每次成功 admin mutation +1（OCC token）；`config_version` 仅 register/update/rotate +1（EndpointVersion append）。
4. **明文 secret 永不存储/解析**；opaque credential_ref；opaque_handle 仅同时具备
   `vendor:snapshot-latest` + `vendor:read-credential-locator` 的
   `DeliveryConfigSnapshot` 可见，其他投影结构性省略。
5. **append-only 审计 + receipt**；脱敏在写入时；摘要不派生自 secret；MVP receipt 不自动过期。
6. **存在性合并**：非特权方 not-found ≡ disabled；授权先于构造。
7. **权威零陈旧（read-after-commit consistency） + 即时生效**：active/latest 读零陈旧；register/activate/disable 即时。
8. **策略数据 vs 运行时**：VR 不解析/连接；retry/timeout/SSRF runtime 归 Delivery。

## Edge Cases

> 确定性判定（condition → 确切结果），不使用模糊措辞。

**错误优先级（H1）**
- If 同一请求同时命中多个错误：只返回 ActorContext → schema →
  kind/capability → scope/scope-filter → cursor/limit（read）或
  receipt/fingerprint（admin）→ existence/version → business rule 中的首个错误。
- If admin update/activate/disable/rotate：`vendor_ids` actor 目标 ∉ scope.vendor_ids → `FORBIDDEN`（查库前，无 AdminAuditEvent per VR-AUDIT-06）；`owning_scopes` actor private owner-resolution ∉ scope 或目标不存在 → 统一 `VENDOR_NOT_FOUND`（scope rejection，不写 audit，见 VR-SCOPE-05）；已授权 `vendor_ids`/`all` 的真实 not-found → `VENDOR_NOT_FOUND`（写 rejected audit，见 VR-AUDIT-08）；register 冲突 → `VENDOR_ID_UNAVAILABLE`。
- If latest read vendor 不存在/disabled/out-of-scope：`is_vendor_active` →
  `{active:false}`；`snapshot({latest_active})` →
  `VENDOR_INACTIVE_OR_UNKNOWN`。

**Per-attempt authoritative**
- If vendor 被 disable 后下一个未开始 attempt 调 `snapshot({latest_active})`：→ `VENDOR_INACTIVE_OR_UNKNOWN`；Delivery 停止该通知的 attempt。
- If HTTP 已发出（in-flight）后 vendor 被 disable：→ 该 HTTP 允许完成；Delivery 记录其结果。
- If `update_version` 或 `rotate` 后下一个 attempt 调 `snapshot({latest_active})`：→ 反映新 `current_config_version`。

**存在性 / 枚举（C6）**
- If 跨 scope 调用方查他 vendor：非特权 → `VENDOR_INACTIVE_OR_UNKNOWN`（相同公开 status/schema/error/cache-policy）。
- If `list_vendors`：只返回 scope 内；无 count 泄露；live keyset；cursor 跨 scope → `INVALID_CURSOR`。
- If 授权与构造顺序：**auth → scope → existence → construct**。

**管理员写并发（C7/C8）**
- If 两 admin 并发改同一 vendor：经 `record_revision` OCC；恰一成功；败方 `EXPECTED_VERSION_MISMATCH`（不含 last_writer actor）。
- If 同 `(actor_id, idempotency_key)` + 同 `command_fingerprint`：→ 返回原 `safe_result`，不重新应用。
- If 同 key + 不同 `command_fingerprint`：→ `IDEMPOTENCY_CONFLICT`。

**生命周期（单向前向，即时生效）**
- If `disabled→active`：`INVALID_TRANSITION`（单向前向）。
- If disabled 上 `update_version` 或 `rotate`：`VENDOR_DISABLED_UPDATE_FORBIDDEN`。
- If register 任一已存在/disabled/tombstoned/其他 owner 已占用 id：
  `VENDOR_ID_UNAVAILABLE`；详细原因不进入响应、audit 或可关联 runtime event。

**时钟（C10）**
- If 调用方提供 `now`/`client_time`/`timestamp`/scheduling 字段：闭合 schema **拒绝**。register/activate/disable 即时生效。

**快照不对称**
- If `snapshot({specific,N})` 而 vendor 现 disabled：具 `vendor:read-history` 时返回
  `HistoricalConfigSnapshot`。
- If `snapshot({latest_active})` 而 vendor disabled：所有调用方均
  `VENDOR_INACTIVE_OR_UNKNOWN`；特权历史读取只经 `{specific,N}`。
- If `snapshot({specific,N})` 由非特权调用：拒绝（防枚举）。
- If latest caller 缺 `vendor:snapshot-latest` 或
  `vendor:read-credential-locator`：`FORBIDDEN`，不返回动态删字段版本。

**配置校验（BL-05 defense-in-depth）**
- If endpoint 含 wildcard / port ∉ configured allowlist / 危险 CIDR / 未知 schema 字段：`INVALID_ENDPOINT_POLICY` + 安全事件。
- If `credential_ref` scheme ∉ configured allowlist 或 embed inline/plaintext：`INVALID_CREDENTIAL_REF`（通过 configured closed scheme/profile validator 确定性判定；不使用 `secret-pattern` 谓词）。

**能力 / 伪造**
- If 调用方 body 自报 actor/scope/kind/capabilities：**闭合 schema 拒绝**（非"忽略"）。
- If actor kind 无对应 capability：拒绝。
- If actor 试图 view-plaintext：操作不存在。

**权威零陈旧（read-after-commit consistency）**
- If `is_vendor_active` / `snapshot({latest_active})` 在 disable 成功提交后读取：
  **立即**反映 disabled（无 bounded 陈旧窗口）。
  缓存仅当 proven synchronous invalidation 保同一权威行为时允许。

**collection keyset**
- If cursor malformed / cross-operation / cross-scope / filter-mismatched：`INVALID_CURSOR`。
- If limit <1 或 >200：`INVALID_PAGE_LIMIT`。
- If `list_vendors` live 分页中新行出现在后续页：正常（immutable sort key 防止行移动）。

**Scope 授权（G1）**
- If `vendor_ids` scope actor register：`FORBIDDEN`；不读 VendorRecord、不入库。
- If `owning_scopes` 多元素 actor register：必须显式提交单值
  `body.owning_scope` 且属于其 scope；缺失 → `INVALID_COMMAND`，越权 →
  `FORBIDDEN`。
- If 跨 scope 或不存在 vendor 对受限读调用方：按 H1 的操作矩阵返回唯一安全
  结果，不泄露 lifecycle/version。
- If `owning_scopes` 授权：经私有 owner-resolution，无 externally observable existence 结果。

**URL / SSRF 元组（G2）**
- If endpoint URL scheme = `http` / 含 userinfo / 含 fragment / hostname = wildcard / hostname = IP literal / 含 NUL/CR/LF：→ `INVALID_ENDPOINT_POLICY` + 安全事件。
- If `PrivateNetworkException.hostname` / `port` 与 canonical URL authority 不一致：→ `INVALID_ENDPOINT_POLICY`。
- If `PrivateNetworkException.cidr` 与同地址族 `FORBIDDEN_CIDR_EXCEPTION_RANGES` 任一成员存在地址交集，或 prefix length < `MIN_CIDR_EXCEPTION_PREFIX_LENGTH`，或非 canonical network CIDR：→ `INVALID_ENDPOINT_POLICY`。

**端点配置替换（G3）**
- If `replacement_policy` 缺必填字段 / 含未知字段 / 试图 null-delete 或 partial patch：→ `INVALID_COMMAND`（update 一律全量替换）。
- If `update_version` body 含 `credential_ref` 字段：→ `INVALID_COMMAND`（credential 只能经 `rotate_credential_ref`）。
- If `HeaderRule.literal` name 为认证类（Authorization / Cookie / Proxy-Authorization）或 value 含 CR/LF/NUL：→ `INVALID_ENDPOINT_POLICY`。
- If `OutboundIdempotencyMapping` 同时指定 header 与 body_field（非互斥单选）：→ `INVALID_COMMAND`。
- If Header 名 lowercase 规范化后重复、越 allowed、命中 forbidden，或
  literal/credential Header 彼此冲突：`INVALID_ENDPOINT_POLICY`。
- If idempotency header 与 literal/credential/其他 mapping 重名，或 mapping
  闭合集外/非互斥：`INVALID_COMMAND`。
- If credential_field 与 auth strategy profile 不兼容：
  `INVALID_ENDPOINT_POLICY`。
- If `max_request_body_bytes` 不在 1..262144：
  `INVALID_ENDPOINT_POLICY`，不持久化。

**Receipt replay after revocation（G4）**
- If 成功 receipt 重放时 actor 权限 / scope 已被撤销：→ `FORBIDDEN`，不返回旧 `safe_result`、不泄露存在性。

**Collection scope-filter（G6）**
- If 非 all actor 提交跨 kind filter，或 filter 扩大自身 scope：
  `FORBIDDEN_SCOPE_FILTER`。
- If `list_endpoint_versions` 携带 scope_filter：`INVALID_COMMAND`。
- If `list_admin_audit_events` 首次查询无事件：
  `snapshot_max_audit_seq=null`。
- If cursor 的 snapshot cap 与当前遍历不符：→ `INVALID_CURSOR`。

**配置代际切换（G7）**
- If 安全 allowlist 收紧预检发现既有 active 配置违规：→ 该次发布 fail-closed（旧配置代际继续生效，新代际不发布），要求先 update 或 disable 违规 vendor；无静默 grandfather。
- If URL / Header name / Header value / Header count / method / admin key /
  disable reason / per-vendor body / page 任一越 H7 边界：返回对应闭合错误，
  不接受越界配置。

**提交失败（H8）**
- If VR 已确认事务未提交：`COMMIT_ROLLED_BACK`；无持久副作用；发一条去敏
  `operation_failed` runtime event；同 key 重试按新命令处理。
- If commit outcome unknown：首次 `COMMIT_OUTCOME_UNKNOWN` 不携带未确认的
  `AdminResult`；同 key 重试收敛，最终最多一条 receipt。

## Dependencies

- **硬设计依赖：无**（Layer 0）。
- **消费方（binding）**：ingress（`is_vendor_active`）、Delivery（per-attempt `snapshot({latest_active})`）。
- **Notification Store**：运行时不查询 VR（AC-SEC-04 硬边界）。
- **opaque credential_ref → secret-store（KMS/Vault）**：Delivery 发送的运行时依赖，非 VR 的。
- **漂移守卫**：若任何 VR 设计要求运行时 DNS 解析/连接/SSRF 执行/retry/timeout 策略 → 暂停（归 Delivery）。

## Configuration

> Environment owner 均为 platform / SRE。配置按原子代际 all-or-nothing
> 发布；缺失必需项或任一非法值使新代际 fail-closed，不影响旧代际。所有长度均按
> UTF-8 / wire bytes 计；下表给出默认、闭合范围、发布行为与风险。

| 配置 / 约束 | 默认 | 合法范围 | 发布行为 / operational risk |
|---|---|---|---|
| `vendor_id` charset | `^[a-z0-9-]{1,64}$` | 1–64 ASCII chars；不可重用 | CDD 固定 schema；违反 → `INVALID_COMMAND` |
| `ENDPOINT_PORT_ALLOWLIST` | `{443}` | `set<int>`；每项 1–65535 | 收紧须预检 active 配置；违规新代际不发布 |
| `ENDPOINT_METHOD_ALLOWLIST` | `{POST}` | 闭合子集 `{POST, PUT, PATCH}` | 收紧须预检；越集 → `INVALID_ENDPOINT_POLICY` |
| `CREDENTIAL_REF_SCHEME_ALLOWLIST` / `CREDENTIAL_PROFILE_VALIDATOR` | **无隐式默认** | 非空闭合 scheme 集 + 对应 profile validator | 缺失/非法 → 启动失败；错误放宽可能暴露凭证定位符 |
| `STATIC_HEADER_NAME_ALLOWLIST` | `{accept, content-type, user-agent}` | lowercase ASCII HTTP token 集；认证类 Header 不得进入 | 收紧须预检；越集 literal → `INVALID_ENDPOINT_POLICY` |
| Header name | N/A | ASCII HTTP token；1–128 bytes；lowercase 规范化比较 | 超长/非法/规范化冲突 → `INVALID_ENDPOINT_POLICY` |
| literal Header value | N/A | 0–1024 bytes；禁 NUL/CR/LF 与其他非法控制字符 | 违反 → `INVALID_ENDPOINT_POLICY` |
| `FORBIDDEN_CIDR_EXCEPTION_RANGES` | platform 安全基线 | 不可例外的危险范围集（loopback、link-local、metadata 等；按地址族） | 收紧须预检；仅配置期例外校验（同地址族地址交集），不能替代 Delivery 运行时 blocklist |
| `MIN_CIDR_EXCEPTION_PREFIX_LENGTH_V4` | `8` | int 0–32 | cidr v4 prefix < MIN → `INVALID_ENDPOINT_POLICY`；允许显式企业网段、拒绝 `/0` catch-all |
| `MIN_CIDR_EXCEPTION_PREFIX_LENGTH_V6` | `48` | int 0–128 | cidr v6 prefix < MIN → `INVALID_ENDPOINT_POLICY` |
| `owning_scope` charset | `[a-z0-9._-]{1,128}` | lowercase ASCII；uppercase 拒绝（不 case-fold） | 违反 → `INVALID_COMMAND`（body）/ `INVALID_ACTOR_CONTEXT`（scope） |
| ActorContext scope set caps | `vendor_ids` / `owning_scopes` 各非空、duplicate-free、≤32 | 成员符合对应 charset | 违反 → `INVALID_ACTOR_CONTEXT` |
| endpoint URL | N/A | 1–2048 bytes；其余语法见 Core Spec | 违反 → `INVALID_ENDPOINT_POLICY` |
| `transport_auth_headers` count | `0` | 0–32 | 超限 → `INVALID_ENDPOINT_POLICY`；过高增加请求面与审计负担 |
| admin `idempotency_key` | N/A（必填） | `[A-Za-z0-9._-]{1,255}` | 违反 → `INVALID_COMMAND` |
| `disable.reason` | N/A（必填） | 1–1024 UTF-8 bytes | 缺失/越界 → `INVALID_COMMAND` |
| `endpoint_policy.max_request_body_bytes` | `262144` | 1–262144 bytes | **VR 写入时**越界 → `INVALID_ENDPOINT_POLICY`；限制单供应商策略的请求体预算 |
| `LIST_PAGE_DEFAULT` / `LIST_PAGE_MAX` | `50` / `200` | request limit 1–200 | 越界 → `INVALID_PAGE_LIMIT`；限制查询内存/延迟 |

- **删除** 旧的危险 CIDR 单一名单（语义模糊；拆为 `FORBIDDEN_CIDR_EXCEPTION_RANGES` ［配置期］与 Delivery 运行时 destination blocklist）。
- **删除** `CACHE_STALENESS_MAX_SECONDS`（权威读路径零陈旧）。
- **明确不归 VR（→ Delivery / Architecture）**：`retry_policy` + outbound `timeout_ms` · 出站幂等键注入 · SSRF 运行时算法（DNS pinning / 不跟重定向 / IP 校验）· KMS/Vault · 调用方认证 · URL parser / IDNA / 完整 CIDR 算法 / 配置存储机制。
- **治理**：上述数值预算或闭合集默认经 CDD 修订；若变更影响栈/部署/迁移
  方案，须另立 ADR；若触及 T0 法律立场，须走 constitutional amendment。

## Integration Requirements

**读 API**：`snapshot` / `is_vendor_active` / `list_vendors` /
`list_endpoint_versions` / `list_admin_audit_events` /
`describe_vendor_state`——均为行为契约（非框架路由）。`latest_active` 要求
`vendor:snapshot-latest` **AND** `vendor:read-credential-locator`，返回
`DeliveryConfigSnapshot`；`specific` 返回无 locator 的
`HistoricalConfigSnapshot`。集合只返回闭合 item / summary 投影和有界 cursor。

**管理员写 API**（VR 独占）：`register` / `update_version` / `activate` /
`disable` / `rotate_credential_ref`——均消费 `AdminCommand` + ActorContext，
并按 kind + scope + capability + `expected_record_revision` +
`idempotency_key` 闭合校验。

**错误形状**：写操作只返回闭合 `AdminCommandError(13)`；读操作只返回闭合
`ReadError(9)`。错误优先级唯一，非特权存在性结果稳定去敏，授权先于构造；
`COMMIT_ROLLED_BACK` 与 `COMMIT_OUTCOME_UNKNOWN` 按 Core Spec F 收敛。
**明确不包含**：出站 HTTP / DNS 解析 / secret 解析 / retry/timeout 策略 → Delivery / KMS / Architecture。

## UI Requirements

**N/A — internal service configuration module（MVP 无 operator UI）。** Vendor Registry 独占其程序化 admin / 审计读契约；本 CDD 不指定 operator UI。

## Acceptance Criteria

> 全部 Given–When–Then，可观测行为 + 证据类型。

**A. Register**
- **VR-INTAKE-01**〔API Contract〕**GIVEN** 无既有 `vendor_id` + actor scope=`all` 或 `owning_scopes` 且 `body.owning_scope` 在其范围内 + `vendor:register` + 有效 `AdminCommand(register)`（body={owning_scope, initial_config}）+ `expected_record_revision=0` + `idempotency_key` **WHEN** 处理 **THEN** `draft`@record_revision=1 + `owning_scope` 来自 body + EndpointVersion config_version=1 + 恰一条 success AdminAuditEvent + AdminCommandReceipt。
- **VR-INTAKE-02**〔Logic〕**GIVEN** `vendor_id` 违 charset **WHEN** register **THEN** `INVALID_COMMAND`（非 `VENDOR_ID_UNAVAILABLE`），不入库。
- **VR-INTAKE-03**〔Logic〕**GIVEN** `vendor_id` 长度 > 64 **WHEN** register **THEN** `INVALID_COMMAND`，不入库。
- **VR-INTAKE-04**〔API Contract〕**GIVEN** `AdminCommand` body 含未知字段 **WHEN** register **THEN** `INVALID_COMMAND`（闭合 schema），不入库。
- **VR-INTAKE-05**〔Security Negative〕**GIVEN** body 自报 actor/kind/scope/capabilities **WHEN** register **THEN** `INVALID_COMMAND`（闭合 schema 拒绝，非"忽略"），不入库。
- **VR-INTAKE-06**〔Security Negative〕**GIVEN** actor 缺 `vendor:register` capability **WHEN** register **THEN** `FORBIDDEN`，不入库。
- **VR-INTAKE-07**〔Security Negative〕**GIVEN** actor scope=`{vendor_ids:{A}}` + register **WHEN** 处理 **THEN** `FORBIDDEN`（register 仅允许 `owning_scopes|all`），不读 VendorRecord、不入库。
- **VR-INTAKE-08**〔Security Negative〕**GIVEN** register 的 `vendor_id` 已存在、disabled、tombstoned 或被其他 owning scope 占用 **WHEN** 处理 **THEN** 外部统一 `VENDOR_ID_UNAVAILABLE`，不区分存在性、生命周期或 owner。
- **VR-INTAKE-09**〔Security Negative〕**GIVEN** register 冲突 **WHEN** 写 AdminAuditEvent 或可关联 runtime event **THEN** 仅记录 `VENDOR_ID_UNAVAILABLE`；详细冲突原因不进入外部响应/审计/可关联 runtime，内部只允许无 vendor/owner/lifecycle 标识的聚合指标。
- **VR-INTAKE-10**〔API Contract〕**GIVEN** register `body.owning_scope` **WHEN** 校验 **THEN** 必须匹配 `[a-z0-9._-]{1,128}`（lowercase ASCII；uppercase 直接拒绝，不做运行时 case-fold）；违 → `INVALID_COMMAND`。

**B. Lifecycle**
- **VR-LIFE-01**〔Logic〕**GIVEN** `draft`@record_revision=1 **WHEN** `activate` + `vendor:activate` + `expected_record_revision=1` **THEN** →`active`@record_revision=2；config_version 不变。
- **VR-LIFE-02**〔Logic〕**GIVEN** `active`@R **WHEN** `disable` + reason + `vendor:disable` + `expected_record_revision=R` **THEN** →`disabled`@R+1；config_version 不变；此后不可回 active/draft。
- **VR-LIFE-03**〔API Contract〕**GIVEN** disable 缺 reason **WHEN** 处理 **THEN** `INVALID_COMMAND`，状态不变。
- **VR-LIFE-04**〔Logic〕**GIVEN** `draft` **WHEN** disable + reason + capability **THEN** →`disabled`（直接跳过 active）。
- **VR-LIFE-05**〔Logic〕**GIVEN** `disabled` **WHEN** update_version 或 rotate **THEN** `VENDOR_DISABLED_UPDATE_FORBIDDEN`。
- **VR-LIFE-06**〔Logic〕**GIVEN** `disabled` **WHEN** activate **THEN** `INVALID_TRANSITION`。
- **VR-LIFE-07**〔Logic〕**GIVEN** disabled/tombstoned `vendor_id` **WHEN** register 同 id **THEN** `VENDOR_ID_UNAVAILABLE`，不泄露生命周期。
- **VR-LIFE-08**〔Logic〕**GIVEN** 既有 draft/active `vendor_id` **WHEN** register 同 id **THEN** `VENDOR_ID_UNAVAILABLE`，不泄露存在性。

**C. Snapshot（per-attempt + 不对称）**
- **VR-SNAPSHOT-01**〔API Contract〕**GIVEN** active vendor + current config_version=V3 + actor 同时具备 `vendor:snapshot-latest` 与 `vendor:read-credential-locator` **WHEN** `snapshot({latest_active})` **THEN** 返回 `DeliveryConfigSnapshot` 绑定 config_version=V3（权威、零陈旧）。
- **VR-SNAPSHOT-02**〔Security Negative〕**GIVEN** disabled vendor + 非特权 **WHEN** `snapshot({latest_active})` **THEN** `VENDOR_INACTIVE_OR_UNKNOWN`，不泄露字节。
- **VR-SNAPSHOT-03**〔Security Negative〕**GIVEN** 不存在 vendor **WHEN** `snapshot({latest_active})` **THEN** `VENDOR_INACTIVE_OR_UNKNOWN`，与 02 字节不可区分。
- **VR-SNAPSHOT-04**〔API Contract〕**GIVEN** disabled vendor 历史有 config_version=2 + `vendor:read-history` **WHEN** `snapshot({specific,2})` **THEN** 返回无 `opaque_handle` 的 `HistoricalConfigSnapshot`，历史**字段级语义不变**（底层 EndpointVersion 持久化字节不可变见 VR-IMM-01；response wire 字节稳定性属 Architecture）。
- **VR-SNAPSHOT-05**〔Security Negative〕**GIVEN** 同 04 但缺 `vendor:read-history` **WHEN** `snapshot({specific,2})` **THEN** `FORBIDDEN`。
- **VR-SNAPSHOT-06**〔API Contract〕**GIVEN** config_version 1..3 + 特权请求 `{specific,99}` **WHEN** snapshot **THEN** `VERSION_NOT_FOUND`。
- **VR-SNAPSHOT-07**〔Integration〕**GIVEN** disable 成功后下一个未开始 attempt 调 `snapshot({latest_active})` **WHEN** 处理 **THEN** 立即（零陈旧）返回 `VENDOR_INACTIVE_OR_UNKNOWN`；Delivery 停止。
- **VR-SNAPSHOT-08**〔Integration〕**GIVEN** HTTP 已发出后 vendor 被 disable **WHEN** Delivery 处理 **THEN** 该 HTTP 允许完成；Delivery 记录结果。

**D. Snapshot projection（H3）**
- **VR-PROJ-01**〔Security Negative〕**GIVEN** `snapshot({latest_active})` + actor 同时具备 `vendor:snapshot-latest` 与 `vendor:read-credential-locator` **WHEN** 返回 **THEN** 使用 `DeliveryConfigSnapshot`（完整 opaque CredentialRef 可含 `opaque_handle`，但无明文 secret）；缺任一 capability → `FORBIDDEN` 且不返回动态删字段版本。
- **VR-PROJ-02**〔Security Negative〕**GIVEN** `snapshot({specific,N})`、历史列表或审计读取 **WHEN** 返回 **THEN** 使用 `HistoricalConfigSnapshot` 或闭合历史 item；credential 仅含 scheme/reference_version，永不含 `opaque_handle`。
- **VR-PROJ-03**〔API Contract〕**GIVEN** 同一 `(vendor_id, config_version, projection_schema)` **WHEN** 多次读取 snapshot **THEN** 响应**字段级语义相等**（同一组字段、同字段同值；不要求 wire 字节相等——canonical wire serialization 属 Architecture deferred），且 `projection_schema ∈ {delivery-v1,historical-v1}`。

**E. Query / Collection（keyset）**
- **VR-QUERY-01**〔Security Negative〕**GIVEN** (a) 无记录 或 (b) disabled **WHEN** `is_vendor_active` **THEN** 两情形均 `{active:false}`，形状不可区分。
- **VR-QUERY-02**〔API Contract〕**GIVEN** active **WHEN** `is_vendor_active` **THEN** `{active:true}`。
- **VR-QUERY-03**〔Logic〕**GIVEN** draft **WHEN** `is_vendor_active` **THEN** `{active:false}`。
- **VR-QUERY-04**〔Security Negative〕**GIVEN** vendors 在 tenant-acme + tenant-beta，caller scope=tenant-acme 且 `scope_filter`（若提供）为 actor scope 子集 **WHEN** `list_vendors` **THEN** 仅返回 tenant-acme 的 `VendorListItem`，无 total_count 泄露（越界 filter 见 VR-QUERY-12）。
- **VR-QUERY-05**〔Security Negative〕**GIVEN** 50 vendors scope 内, page_size=10 **WHEN** list page 1 **THEN** items + next_cursor；无 total_count/remaining。
- **VR-QUERY-06**〔Security Negative〕**GIVEN** cursor 原发 tenant-acme **WHEN** 被 tenant-beta caller 重放 **THEN** `INVALID_CURSOR`。
- **VR-QUERY-07**〔API Contract〕**GIVEN** disabled vendor + `vendor:read` **WHEN** `describe_vendor_state` **THEN** 返回闭合 `VendorStateSummary`，不嵌入无界数组。
- **VR-QUERY-08**〔Security Negative〕**GIVEN** 缺 `vendor:read` **WHEN** `describe_vendor_state`（任意 id） **THEN** `FORBIDDEN`。
- **VR-QUERY-09**〔API Contract〕**GIVEN** limit <1 或 >200 **WHEN** list **THEN** `INVALID_PAGE_LIMIT`。
- **VR-QUERY-10**〔API Contract〕**GIVEN** 经目标 vendor 授权且未提交 `scope_filter` 的 `list_endpoint_versions` 首次固定 `snapshot_max_config_version=V` **WHEN** 翻页 **THEN** 后续页只读 `config_version ≤ V` 的不可变 `EndpointVersionListItem`（升序），返回 `{items,next_cursor,snapshot_max_config_version}`。
- **VR-QUERY-11**〔API Contract〕**GIVEN** 合法 `scope_filter` 的 `list_admin_audit_events` 首次固定 `snapshot_max_audit_seq=S` **WHEN** 翻页 **THEN** 后续页只遍历 `audit_seq ≤ S` 的冻结前缀（`audit_seq DESC,event_id DESC`）；首次空集固定 `S=null`。
- **VR-QUERY-12**〔Security Negative〕**GIVEN** `scope_filter` 扩大至 ActorContext `scope` 之外 **WHEN** list **THEN** `FORBIDDEN_SCOPE_FILTER`。
- **VR-QUERY-13**〔API Contract〕**GIVEN** `list_endpoint_versions` 首次固定 `snapshot_max_config_version=V`，中途新增 `config_version=V+1` **WHEN** 继续翻页 **THEN** `V+1` 不进入当前遍历（只读 `≤ V`）。
- **VR-QUERY-14**〔API Contract〕**GIVEN** `list_admin_audit_events` 首次固定 `snapshot_max_audit_seq=S`，中途新增 `audit_seq>S` 事件 **WHEN** 用绑定 `(audit_seq,event_id)` 的 cursor 继续翻页 **THEN** 新事件只在下一次遍历出现。
- **VR-QUERY-15**〔Security Negative〕**GIVEN** cursor 跨 operation / scope / filter / direction / snapshot-cap **WHEN** 重放 **THEN** `INVALID_CURSOR`。
- **VR-QUERY-16**〔Security Negative〕**GIVEN** `scope_filter` 与 actor scope **WHEN** 校验 **THEN** `vendor_ids` actor 仅可给其 vendor_ids 子集（duplicate-free、≤32、成员符合 `^[a-z0-9-]{1,64}$`）、`owning_scopes` actor 仅可给其 owning_scopes 子集（duplicate-free、≤32、成员符合 `[a-z0-9._-]{1,128}`，uppercase 拒绝）、`all` 可省略或给任一闭合 filter；非 all actor 跨 kind filter → `FORBIDDEN_SCOPE_FILTER`。
- **VR-QUERY-17**〔API Contract〕**GIVEN** `list_endpoint_versions` **WHEN** 调用 **THEN** 经目标 `vendor_id` 授权且不接受 `scope_filter`；提交 filter → `INVALID_COMMAND`。
- **VR-QUERY-18**〔API Contract〕**GIVEN** 任一集合查询成功 **WHEN** 装配结果 **THEN** item 分别为闭合 `VendorListItem`、`EndpointVersionListItem` 或 `AdminAuditListItem`，无未定义字段。
- **VR-QUERY-19**〔API Contract〕**GIVEN** `describe_vendor_state` 成功 **WHEN** 返回 **THEN** 使用固定字段集 `VendorStateSummary`，不嵌入 endpoint/audit 无界数组。
- **VR-QUERY-20**〔Logic〕**GIVEN** AdminAuditEvent 写入 **WHEN** 持久化 **THEN** `audit_seq` 全局唯一、严格递增（允许数值间隙），audit cursor 绑定 `(audit_seq,event_id)` 且按二者倒序。
- **VR-QUERY-21**〔API Contract〕**GIVEN** `list_admin_audit_events` 首次查询无事件 **WHEN** 返回 **THEN** `snapshot_max_audit_seq=null`，不允许实现自选其他哨兵值。
- **VR-QUERY-22**〔Security Negative〕**GIVEN** 经目标 `vendor_id` 的 `list_endpoint_versions`，目标 vendor 不存在或不在 actor scope（`vendor_ids` 目标 ∉ scope，或 `owning_scopes` 私有 owner-resolution 未命中） **WHEN** 处理 **THEN** 统一 `VENDOR_NOT_FOUND`（不区分存在性；不返回 `FORBIDDEN`/列表二选一）。
- **VR-QUERY-23**〔API Contract〕**GIVEN** 已授权（`vendor:read-history`）且目标存在的 `list_endpoint_versions`（目标 lifecycle ∈ draft/active/disabled 任一） **WHEN** 处理 **THEN** 返回完整分页响应 `{items: EndpointVersionListItem[], next_cursor?, snapshot_max_config_version}`（特权历史读取；lifecycle 不阻断；分页/snapshot cap/scope_filter 见 VR-QUERY-10/13/17/18）。
- **VR-QUERY-24**〔Security Negative〕**GIVEN** `describe_vendor_state`，目标 vendor 不存在或不在 actor scope **WHEN** 处理 **THEN** 统一 `VENDOR_NOT_FOUND`（不区分存在性）。
- **VR-QUERY-25**〔API Contract〕**GIVEN** 已授权（`vendor:read`）且目标存在的 `describe_vendor_state`（目标 lifecycle ∈ draft/active/disabled 任一） **WHEN** 处理 **THEN** 返回闭合 `VendorStateSummary`（特权状态读取；lifecycle 不阻断；字段集见 VR-QUERY-19）。

**F. Concurrency / Idempotency**
- **VR-CONCURRENCY-01**〔Concurrency〕**GIVEN** vendor@record_revision=3 **WHEN** update with expected=2 **THEN** `EXPECTED_VERSION_MISMATCH`，无新版本。
- **VR-CONCURRENCY-02**〔Security Negative〕**GIVEN** 两并发 update, B 败方 **WHEN** B 被拒 **THEN** 响应不含 last_writer actor。
- **VR-CONCURRENCY-03**〔Concurrency〕**GIVEN** 两 register 同 id **WHEN** 处理 **THEN** 恰一成功。
- **VR-CONCURRENCY-04**〔Concurrency〕**GIVEN** register 以 k1 成功（record_revision=1） **WHEN** 同 caller（授权仍有效）重交 k1 + 同 command_fingerprint **THEN** 返回原 `safe_result: AdminResult`，不重新应用 state/version/audit/receipt。
- **VR-CONCURRENCY-05**〔Concurrency〕**GIVEN** 同 k1 + 不同 command_fingerprint **WHEN** 处理 **THEN** `IDEMPOTENCY_CONFLICT`。
- **VR-CONCURRENCY-06**〔Concurrency〕**GIVEN** 写超时（`COMMIT_OUTCOME_UNKNOWN`）后的同 k1 重交（授权仍有效） **WHEN** 处理 **THEN** 返回已提交 `AdminResult` 或重新处理（收敛语义；首次响应与 receipt 基数见 VR-CONCURRENCY-08）。
- **VR-CONCURRENCY-07**〔Concurrency〕**GIVEN** Vendor Registry 持久化事务已确认未提交（`COMMIT_ROLLED_BACK`） **WHEN** 处理 **THEN** 无 VendorRecord/EndpointVersion/AdminAuditEvent/AdminCommandReceipt 持久副作用，发一条去敏 `operation_failed` runtime event；同 `(actor_id,idempotency_key)` 重试按新命令正常处理。
- **VR-CONCURRENCY-08**〔Concurrency〕**GIVEN** 提交结果未知（`COMMIT_OUTCOME_UNKNOWN`） **WHEN** 首次响应 **THEN** 不携带未经确认的 `AdminResult`；仅通过同 key 重试收敛，最终最多一条 receipt。

**G. Security / Existence**
- **VR-SEC-01**〔Security Negative〕**GIVEN** caller `scope={vendor_ids:{A}}` snapshot vendor_id=B（存在、active、scope B） **WHEN** 处理 **THEN** `VENDOR_INACTIVE_OR_UNKNOWN`（`vendor_ids` 在 lookup 前直接判定）。
- **VR-SEC-02**〔Security Negative〕**GIVEN** caller 请求他 scope vendor **WHEN** 经 `owning_scopes` owner-resolution **THEN** 无可观测副作用泄露存在性。
- **VR-SEC-03**〔Security Negative〕**GIVEN** 跨 scope 请求 **WHEN** 处理 **THEN** 相同公开 status/schema/error/cache-policy；响应不携带存在性/状态/版本信息（不声称时延不可区分）。
- **VR-SEC-04**〔Integration〕**GIVEN** 任一 NS workflow **WHEN** 需 vendor 信息 **THEN** NS 不发 VR 读。
- **VR-SEC-05**〔Logic〕**GIVEN** `vendor_id` 违 charset **WHEN** 任一 op 处理 **THEN** `INVALID_COMMAND`，先于 lookup/authz/audit。
- **VR-SEC-06**〔Security Negative〕**GIVEN** caller `scope={vendor_ids:{A}}` 提交 crafted vendor_id **WHEN** 任一 op **THEN** 授权只用 scope A（`vendor_ids` 直接比较先于 lookup）。
- **VR-SEC-07**〔Security Negative〕**GIVEN** 下游消费方通过 `is_vendor_active` 或 `snapshot({latest_active})` 判定供应商状态，且目标属于 unknown / draft / disabled / out-of-scope 任一负向情形 **WHEN** 消费 VR 结果 **THEN** 仅获得对应的合并负向结果（`{active:false}` / `VENDOR_INACTIVE_OR_UNKNOWN`），不得获得区分上述原因的错误名或信号；已授权 active 目标仍分别按 VR-QUERY-02 / VR-SNAPSHOT-01 返回 `{active:true}` / `DeliveryConfigSnapshot`；外部 HTTP 映射归 ingress composition contract，并在 Caller Access CDD 与 Architecture API contract 中闭合。

**H. Credential secrecy**
- **VR-CRED-01**〔Security Negative〕**GIVEN** EndpointVersion 含 opaque CredentialRef **WHEN** snapshot 返回 **THEN** `DeliveryConfigSnapshot` 在双 capability 门控下可含 `opaque_handle`；`HistoricalConfigSnapshot` 与其他投影结构性省略 locator；明文 secret 永不出现。
- **VR-CRED-02**〔Security Negative〕**GIVEN** 任一 op 触及 credential_ref **WHEN** 任一日志受检 **THEN** 无明文；opaque_handle 脱敏或仅以 non-secret-derived reference id 出现。
- **VR-CRED-03**〔API Contract〕**GIVEN** scheme ∉ configured allowlist **WHEN** register/rotate **THEN** `INVALID_CREDENTIAL_REF`（update_version 不携带 credential_ref，见 VR-CRED-07）。
- **VR-CRED-04**〔Security Negative〕**GIVEN** credential_ref embed inline/plaintext（通过 configured validator 判定） **WHEN** 处理 **THEN** `INVALID_CREDENTIAL_REF` + 安全事件。
- **VR-CRED-05**〔Security Negative〕**GIVEN** 任一 caller 枚举 VR API **WHEN** schema 受检 **THEN** 无 view-plaintext 操作。
- **VR-CRED-06**〔Logic〕**GIVEN** active@record_revision=3, config_version=1 + `rotate_credential_ref` body={new_credential_ref} + expected=3 + capability **WHEN** 处理 **THEN** config_version→2, record_revision→4；credential_ref 替换，其余配置继承；v1 不可变。
- **VR-CRED-07**〔API Contract〕**GIVEN** `update_version` body 含 `credential_ref` 字段 **WHEN** 处理 **THEN** `INVALID_COMMAND`（credential 只能经 rotate）。
- **VR-CRED-08**〔Security Negative〕**GIVEN** EndpointVersion 存 `opaque_handle` **WHEN** `HistoricalConfigSnapshot`、历史列表、审计读、summary 或日志返回 **THEN** locator 字段结构性缺席。

**I. Clock**
- **VR-CLOCK-01**〔Logic〕**GIVEN** admin-write 含 now/client_time/timestamp/scheduling **WHEN** 处理 **THEN** `INVALID_COMMAND`（闭合 schema 拒绝）；审计 effective time = 服务端。
- **VR-CLOCK-02**〔Security Negative〕**GIVEN** disable 成功 **WHEN** 下一个未开始 attempt 调 `is_vendor_active` 或 `snapshot({latest_active})` **THEN** 立即（零陈旧）反映 disabled。

**J. BL-05**
- **VR-BL05-01**〔Security Negative〕**GIVEN** 任一 VR op + hostname **WHEN** 处理 **THEN** VR 不发 DNS lookup。
- **VR-BL05-02**〔Security Negative〕**GIVEN** 任一 VR op **WHEN** 处理 **THEN** VR 不开出站连接。
- **VR-BL05-03**〔Security Negative〕**GIVEN** `EndpointTargetInput.url` host 为 metadata IP literal **WHEN** register/update 输入校验 **THEN** `INVALID_ENDPOINT_POLICY`，不产生 canonical state。
- **VR-BL05-04**〔Security Negative〕**GIVEN** `PrivateNetworkException.cidr`（canonical network CIDR）与同地址族 `FORBIDDEN_CIDR_EXCEPTION_RANGES` 任一成员存在任意地址交集，或其 prefix length 小于对应地址族的 `MIN_CIDR_EXCEPTION_PREFIX_LENGTH` **WHEN** register/update 输入校验 **THEN** `INVALID_ENDPOINT_POLICY`（canonical form 与 AF 规则见 VR-BL05-09）。
- **VR-BL05-05**〔Security Negative〕**GIVEN** `EndpointTargetInput.url` host 为 loopback IP literal **WHEN** register/update 输入校验 **THEN** `INVALID_ENDPOINT_POLICY`，不产生 canonical state。
- **VR-BL05-06**〔Security Negative〕**GIVEN** endpoint URL hostname = wildcard **WHEN** 处理 **THEN** `INVALID_ENDPOINT_POLICY`。
- **VR-BL05-07**〔API Contract〕**GIVEN** endpoint canonical URL port ∉ `ENDPOINT_PORT_ALLOWLIST` 或 method ∉ `ENDPOINT_METHOD_ALLOWLIST` **WHEN** 处理 **THEN** `INVALID_ENDPOINT_POLICY`。
- **VR-BL05-08**〔API Contract〕**GIVEN** endpoint canonical URL port 与 method 均在 allowlist 且其余规则合法 **WHEN** 处理 **THEN** 接受。
- **VR-BL05-09**〔API Contract〕**GIVEN** `PrivateNetworkException.cidr` **WHEN** register/update 输入校验 **THEN** 必须为合法 canonical network CIDR（host bits 全 0，如 `10.0.0.0/8` 非 `10.0.0.5/8`；地址族 v4/v6 明确）；non-canonical/host bits 非零/非法 → `INVALID_ENDPOINT_POLICY`。forbidden-range 交集比较（VR-BL05-04）仅对同地址族成员进行。
- **VR-BL05-10**〔API Contract〕**GIVEN** `OutboundIdempotencyMapping` 闭合集外或非互斥单选 **WHEN** 处理 **THEN** `INVALID_COMMAND`。
- **VR-BL05-11**〔API Contract〕**GIVEN** `HeaderRule.literal.name` **WHEN** lowercase 规范化后校验 **THEN** 必须属于 `STATIC_HEADER_NAME_ALLOWLIST` 且不是认证类；否则 `INVALID_ENDPOINT_POLICY`。
- **VR-BL05-12**〔API Contract〕**GIVEN** allowed / forbidden Header 集 **WHEN** lowercase 规范化比较 **THEN** 交集必须为空；否则 `INVALID_ENDPOINT_POLICY`。

**K. Immutability**
- **VR-IMM-01**〔Migration〕**GIVEN** EndpointVersion v2 字节 B **WHEN** 任一后续 op **THEN** v2 字节仍为 B。
- **VR-IMM-02**〔Migration〕**GIVEN** v2 于 schema S1（`config_schema_version=S1`），迁移到 S2 **WHEN** 读 `{specific,2}` **THEN** 匹配 S1 语义或带 `config_schema_version` marker。
- **VR-IMM-03**〔Migration〕**GIVEN** audit event E **WHEN** 任一后续 op **THEN** E 不被改/删。
- **VR-IMM-04**〔API Contract〕**GIVEN** vendor@config_version=5, `{specific,3}` 先前返回 snapshot S3 **WHEN** 再读 **THEN** 字段级语义等于 S3（同一组字段、同字段同值；底层 EndpointVersion 字节不可变见 VR-IMM-01，response wire 字节稳定性属 Architecture）。

**L. Audit / Receipt**
- **VR-AUDIT-01**〔API Contract〕**GIVEN** 成功 register/activate/disable/update_version/rotate_credential_ref **WHEN** op 提交 **THEN** 恰一条 AdminAuditEvent(success, operation) + AdminCommandReceipt，同一事务原子。
- **VR-AUDIT-02**〔Security Negative〕**GIVEN** admin-write 被拒（业务） **WHEN** 处理 **THEN** AdminAuditEvent(outcome=rejected)；credential 脱敏。
- **VR-AUDIT-03**〔Logic〕**GIVEN** admin-write 内部/存储失败 **WHEN** 处理 **THEN** 回滚 state / config-append / audit / receipt（无持久化）；发一条去敏 `operation_failed` runtime security event。
- **VR-AUDIT-04**〔Security Negative〕**GIVEN** 授权后的 credential 操作因业务规则被拒且请求含 `credential_ref` **WHEN** 写入 `AdminAuditEvent(rejected)` 并可选发出 runtime signal **THEN** 两者仅含 opaque reference id 或完全脱敏值，不含明文、locator 或 `command_fingerprint`。
- **VR-AUDIT-05**〔Logic〕**GIVEN** AdminAuditEvent.outcome 枚举 **WHEN** 任一 op **THEN** 仅 `success`/`rejected`；runtime security event 非持久、非 AdminAuditEvent 派生、无独立写路径。
- **VR-AUDIT-06**〔Security Negative〕**GIVEN** invalid/missing ActorContext、闭合-schema 拒绝、kind/capability 拒绝、same-key 不同 fingerprint 拒绝（`IDEMPOTENCY_CONFLICT`），**或 scope rejection**（`vendor_ids` 直接查库前 membership 拒绝，**或 `owning_scopes` 私有 owner-resolution 失败/目标不存在**） **WHEN** 处理 **THEN** **无** AdminAuditEvent、**无** AdminCommandReceipt；仅一条去敏 runtime security event（不含 vendor/owner/lifecycle 标识）。
- **VR-AUDIT-07**〔Logic〕**GIVEN** rejected command **WHEN** 处理 **THEN** **不创建** AdminCommandReceipt（允许同 key 纠正后盲重试）。
- **VR-AUDIT-08**〔API Contract〕**GIVEN** 已授权 admin-write 因业务规则被拒 **WHEN** 持久化 **THEN** 写一条 `AdminAuditEvent(outcome=rejected)`，`reject_reason` ∈ 闭合 7 项（`VENDOR_ID_UNAVAILABLE`/`VENDOR_NOT_FOUND`/`EXPECTED_VERSION_MISMATCH`/`INVALID_TRANSITION`/`VENDOR_DISABLED_UPDATE_FORBIDDEN`/`INVALID_ENDPOINT_POLICY`/`INVALID_CREDENTIAL_REF`）；其中 `VENDOR_NOT_FOUND` 仅在 actor 已授权（`vendor_ids` 目标 ∈ scope 或 `all`）且目标确实不存在时写 rejected audit——`owning_scopes` 的 `VENDOR_NOT_FOUND` 属 scope rejection，不写 audit（见 VR-AUDIT-06/VR-SCOPE-05）。`AdminCommandError(13) = 4 前置-no-audit + 7 业务-with-audit + 2 commit-failure`。

**M. ActorContext / Capability**
- **VR-ACTOR-01**〔Security Negative〕**GIVEN** body 自报 actor/kind/scope/capabilities **WHEN** 任一 op 处理 **THEN** `INVALID_COMMAND`（闭合 schema 拒绝）。
- **VR-ACTOR-02**〔Security Negative〕**GIVEN** actor kind=delivery + capability=vendor:read-active **WHEN** `is_vendor_active` **THEN** 接受。
- **VR-ACTOR-03**〔Security Negative〕**GIVEN** actor kind=operator + 缺 `vendor:update` capability **WHEN** `update_version` **THEN** `FORBIDDEN`。
- **VR-ACTOR-04**〔Security Negative〕**GIVEN** 矩阵中不存在的任意 kind/operation/capability 组合（示例：kind=ingress + capability=vendor:snapshot-latest 调 `snapshot({latest_active})`）**WHEN** 处理 **THEN** `FORBIDDEN`（矩阵闭合：未列组合一律拒绝；ActorContext 本身格式无效或违反 kind×scope 结构矩阵才为 `INVALID_ACTOR_CONTEXT`）。

**N. Scope 授权（G1）**
- **VR-SCOPE-01**〔Security Negative〕**GIVEN** operator `scope={owning_scopes:{S1}}` + register body.owning_scope=S2（S2 ∉ {S1}） **WHEN** 处理 **THEN** `FORBIDDEN`（owning_scope 必须落在 actor scope 内），不入库。
- **VR-SCOPE-02**〔Security Negative〕**GIVEN** admin-write caller `scope={vendor_ids:{A}}` + 目标 vendor_id=B（B≠A） **WHEN** 任一受限写操作 **THEN** 单一 `FORBIDDEN`，且在 vendor lookup 前判定。
- **VR-SCOPE-03**〔Security Negative〕**GIVEN** `owning_scopes` actor 经私有 owner-resolution 命中目标 vendor.owning_scope∉scope 或目标不存在 **WHEN** admin-write（update/activate/disable/rotate）或特权历史读 `snapshot({specific,N})` **THEN** 对外统一 `VENDOR_NOT_FOUND`（与不存在 vendor 不可区分）；本质为 scope rejection：不写 AdminAuditEvent、不写 receipt、仅一条去敏 runtime security event（不含 vendor/owner/lifecycle 标识）。非特权 `snapshot({latest_active})` 读按 Section B 合并为 `VENDOR_INACTIVE_OR_UNKNOWN`。
- **VR-SCOPE-04**〔Security Negative〕**GIVEN** actor kind=ingress + scope={owning_scopes:{S1}}（ingress 仅允许 `vendor_ids`） **WHEN** 任一 op **THEN** `INVALID_ACTOR_CONTEXT`。
- **VR-SCOPE-05**〔Security Negative〕**GIVEN** admin-write caller `scope={owning_scopes:{S1}}` + 目标 vendor.owning_scope=S2（S2≠S1）或目标不存在 **WHEN** 受限写操作（update/activate/disable/rotate）经私有 owner-resolution **THEN** 对外统一 `VENDOR_NOT_FOUND`（与不存在 vendor 不可区分）；本质为 scope rejection：不写 AdminAuditEvent、不写 receipt、仅一条去敏 runtime security event，不泄露目标 vendor/owner/lifecycle。（已授权 `vendor_ids`/`all` 的真实 not-found 才写 rejected audit，见 VR-AUDIT-08。）
- **VR-SCOPE-06**〔API Contract〕**GIVEN** ActorContext `vendor_ids`/`owning_scopes` 集合 **WHEN** 可信认证边界注入 **THEN** 各为非空、duplicate-free、≤32 项，成员符合 charset（`vendor_id`=`^[a-z0-9-]{1,64}$`；`owning_scope`=`[a-z0-9._-]{1,128}`；uppercase 拒绝）；违 → `INVALID_ACTOR_CONTEXT`。

**O. URL / SSRF 元组（G2）**
- **VR-URL-01**〔API Contract〕**GIVEN** register/update 提交 url=`https://api.acme.com` **WHEN** 服务端规范化 **THEN** 持久化 `canonical_url`；snapshot 中 `hostname` / `port` / `transport_kind` 由该 URL 派生（port 缺省 443）。
- **VR-URL-02**〔Security Negative〕**GIVEN** `EndpointTargetInput.url` scheme=http、含 userinfo/fragment、hostname=wildcard/IP-literal 或含 NUL/CR/LF **WHEN** register/update 输入校验 **THEN** `INVALID_ENDPOINT_POLICY`，不产生 canonical state。
- **VR-URL-03**〔Security Negative〕**GIVEN** `PrivateNetworkException.hostname` / `port` 与 canonical URL authority 不一致 **WHEN** 处理 **THEN** `INVALID_ENDPOINT_POLICY`。
- **VR-URL-04**〔API Contract〕**GIVEN** register/update endpoint **WHEN** 派生 `transport_kind` **THEN** `https_private` iff 带 `PrivateNetworkException`（cidr_exception present），否则 `https_public`（唯一规则）。

**P. Endpoint 配置替换（G3）**
- **VR-POLICY-01**〔API Contract〕**GIVEN** `update_version` body={replacement_policy}（完整非凭证配置） + expected=R **WHEN** 处理 **THEN** 新 EndpointVersion N+1 完整替换策略字段，继承当前 credential_ref；无 merge/null-delete/partial patch。
- **VR-POLICY-02**〔API Contract〕**GIVEN** `rotate_credential_ref` body={new_credential_ref} **WHEN** 处理 **THEN** 只替换 credential_ref，其余配置继承；新 EndpointVersion。
- **VR-POLICY-03**〔Security Negative〕**GIVEN** `HeaderRule.literal` name=Authorization（认证类）或 value 含 CR/LF/NUL **WHEN** 处理 **THEN** `INVALID_ENDPOINT_POLICY`。
- **VR-POLICY-04**〔Security Negative〕**GIVEN** `HeaderRule` 为 credential_field **WHEN** 持久化 **THEN** 仅存 opaque selector，凭证值不进 VR。
- **VR-POLICY-05**〔API Contract〕**GIVEN** `OutboundIdempotencyMapping` ∈ {{mode:none},{mode:header,header_name},{mode:body_field,field_name}}（互斥单选） **WHEN** 处理 **THEN** 接受闭合单选；非互斥或越集 → `INVALID_COMMAND`。
- **VR-POLICY-06**〔API Contract〕**GIVEN** Header name **WHEN** 校验或冲突检测 **THEN** 先规范化为 ASCII lowercase；规范化后重复 → `INVALID_ENDPOINT_POLICY`。
- **VR-POLICY-07**〔API Contract〕**GIVEN** `HeaderRule.credential_field` **WHEN** 处理 **THEN** name/selector 必须与 `auth_strategy` 的 configured credential profile 兼容；否则 `INVALID_ENDPOINT_POLICY`。
- **VR-POLICY-08**〔API Contract〕**GIVEN** outbound idempotency header name **WHEN** 处理 **THEN** 必须属于 allowed、不属于 forbidden，且不与 literal/credential/其他 mapping 重名；header/body_field 互斥；违例 → `INVALID_COMMAND`。
- **VR-POLICY-09**〔API Contract〕**GIVEN** `endpoint_policy.max_request_body_bytes` **WHEN** VR 写入 **THEN** 强制 1–262144；越界 → `INVALID_ENDPOINT_POLICY`，不持久化。
- **VR-POLICY-10**〔API Contract〕**GIVEN** `OutboundIdempotencyMapping={body_field,field_name}` **WHEN** 配置期校验 **THEN** `field_name` 必须匹配 `[A-Za-z0-9_.-]{1,128}`（`.` 为普通 key 字符，非路径分隔；flat JSON object key，无 `/[]` 或转义）；运行时仅适用 JSON object payload，不适用时由 Delivery CDD 给出确定结果，不得静默跳过；违 → `INVALID_COMMAND`。
- **VR-POLICY-11**〔API Contract〕**GIVEN** `allowed_request_header_names`/`forbidden_request_header_names` **WHEN** 校验 **THEN** 各为 duplicate-free、lowercase ASCII HTTP token set（成员 1–128 bytes，单集 0–32，交集空）；literal/credential/idempotency 出站 Header 均须 ∈ allowed 且 ∉ forbidden；违 → `INVALID_ENDPOINT_POLICY`。

**Q. Admin command / result / error（G4）**
- **VR-ADMIN-01**〔API Contract〕**GIVEN** admin write 提交为 `AdminCommand={operation,vendor_id,expected_record_revision,idempotency_key,body}` **WHEN** 处理 **THEN** operation ∈ {register,update_version,activate,disable,rotate_credential_ref}；未知 operation / 缺字段 → `INVALID_COMMAND`。
- **VR-ADMIN-02**〔API Contract〕**GIVEN** 成功 admin write **WHEN** 返回 / 写入 receipt **THEN** `safe_result` 类型 = `AdminResult={operation,vendor_id,lifecycle,record_revision,current_config_version}`；无 credential/policy/secret。
- **VR-ADMIN-03**〔Security Negative〕**GIVEN** 成功 receipt（k1）后 actor 权限/scope 被撤销 **WHEN** 同 k1 重交 **THEN** `FORBIDDEN`，不返回旧 `safe_result`、不泄露存在性。

**R. Data model（G5）**
- **VR-MODEL-01**〔Migration〕**GIVEN** EndpointVersion 写入 **WHEN** 持久化 **THEN** 含不可变 `config_schema_version`（来自写入时 schema）；两种 snapshot 的同字段一对一来自该 EndpointVersion。
- **VR-MODEL-02**〔API Contract〕**GIVEN** AdminCommandReceipt 写入 **WHEN** 引用 **THEN** 独立 `receipt_id`（PK）；`(actor_id,idempotency_key)` 保留 unique；`AdminAuditEvent.receipt_id` 指向该字段。
- **VR-MODEL-03**〔API Contract〕**GIVEN** AdminAuditEvent 写入 **WHEN** 持久化 **THEN** 含全局唯一、严格递增的 `audit_seq`；`operation`（非 capability）；`authorization_basis` ∈ {{all},{vendor_id},{owning_scope}}（仅记本次依据）。

**S. Configuration（G7）**
- **VR-CFG-01**〔Logic〕**GIVEN** `CREDENTIAL_REF_SCHEME_ALLOWLIST` / `CREDENTIAL_PROFILE_VALIDATOR` 缺失 **WHEN** 启动 **THEN** fail-closed（无隐式默认），不进入服务。
- **VR-CFG-02**〔API Contract〕**GIVEN** 配置变更含多项 **WHEN** 发布 **THEN** 原子代际切换（all-or-nothing）；非法值 → 整代际不发布。
- **VR-CFG-03**〔Security Negative〕**GIVEN** allowlist 收紧预检发现既有 active 配置违规 **WHEN** 发布 **THEN** 旧代际继续生效、新代际 fail-closed 不发布；无静默 grandfather。
- **VR-CFG-04**〔API Contract〕**GIVEN** `STATIC_HEADER_NAME_ALLOWLIST` **WHEN** 加载 **THEN** 默认 `{accept,content-type,user-agent}`（ASCII lowercase；literal name 约束与认证类禁止见 VR-BL05-11）。
- **VR-CFG-05**〔API Contract〕**GIVEN** 任一 Header name **WHEN** 校验 **THEN** 必须为 1–128 bytes 的 ASCII HTTP token，并以 lowercase 规范化比较；违反 → `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-06**〔API Contract〕**GIVEN** literal Header value **WHEN** 校验 **THEN** 必须为 0–1024 bytes 且不含 NUL/CR/LF 或其他非法控制字符；违反 → `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-07**〔API Contract〕**GIVEN** `ENDPOINT_METHOD_ALLOWLIST` **WHEN** 加载或校验 **THEN** 默认 `{POST}`，合法成员闭合为 `{POST,PUT,PATCH}`；越集 → `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-08**〔API Contract〕**GIVEN** admin `idempotency_key` **WHEN** 校验 **THEN** 必须匹配 `[A-Za-z0-9._-]{1,255}`；违反 → `INVALID_COMMAND`。
- **VR-CFG-09**〔API Contract〕**GIVEN** `disable.reason` **WHEN** 校验 **THEN** 必须为 1–1024 UTF-8 bytes；缺失或越界 → `INVALID_COMMAND`。
- **VR-CFG-10**〔API Contract〕**GIVEN** endpoint URL **WHEN** 校验 **THEN** 必须为 1–2048 bytes；越界 → `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-11**〔API Contract〕**GIVEN** `transport_auth_headers` **WHEN** 校验 **THEN** 数量必须为 0–32；越界 → `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-12**〔API Contract〕**GIVEN** per-vendor `max_request_body_bytes` **WHEN** register/update **THEN** 默认 262144，合法范围 1–262144；越界由 VR 返回 `INVALID_ENDPOINT_POLICY`。
- **VR-CFG-13**〔API Contract〕**GIVEN** 任一 list request limit **WHEN** 校验 **THEN** 缺省 50、最大 200、合法范围 1–200；越界 → `INVALID_PAGE_LIMIT`。
- **VR-CFG-14**〔Logic〕**GIVEN** 上述数值预算或闭合集变更 **WHEN** 选择治理路径 **THEN** 默认经 CDD 修订；影响架构实现则另立 ADR；触及 T0 法律则 constitutional amendment。
- **VR-CFG-15**〔API Contract〕**GIVEN** `MIN_CIDR_EXCEPTION_PREFIX_LENGTH_V4`/`_V6` **WHEN** 加载 **THEN** 默认 `8`/`48`（允许显式企业网段，拒绝 `/0` catch-all）；`PrivateNetworkException.cidr` prefix length 小于对应地址族下限 → `INVALID_ENDPOINT_POLICY`。

**T. Error taxonomy（H1）**
- **VR-ERR-01**〔Logic〕**GIVEN** 同一请求命中多个错误条件 **WHEN** 处理 **THEN** 按 ActorContext → schema → kind/capability → scope/scope-filter → cursor/limit 或 receipt/fingerprint → existence/version → business rule 顺序返回唯一结果。
- **VR-ERR-02**〔API Contract〕**GIVEN** 任一 admin-write 错误 **WHEN** 构造外部结果 **THEN** 错误属于闭合 `AdminCommandError(13)`：`INVALID_ACTOR_CONTEXT`、`INVALID_COMMAND`、`FORBIDDEN`、`VENDOR_ID_UNAVAILABLE`、`VENDOR_NOT_FOUND`、`EXPECTED_VERSION_MISMATCH`、`INVALID_TRANSITION`、`VENDOR_DISABLED_UPDATE_FORBIDDEN`、`INVALID_ENDPOINT_POLICY`、`INVALID_CREDENTIAL_REF`、`IDEMPOTENCY_CONFLICT`、`COMMIT_ROLLED_BACK`、`COMMIT_OUTCOME_UNKNOWN`；无其他外部错误名。
- **VR-ERR-03**〔API Contract〕**GIVEN** 任一读操作的拒绝 **WHEN** 构造外部结果 **THEN** 错误属于闭合 `ReadError(9)`：`INVALID_ACTOR_CONTEXT`、`INVALID_COMMAND`、`FORBIDDEN`、`FORBIDDEN_SCOPE_FILTER`、`VENDOR_INACTIVE_OR_UNKNOWN`、`VENDOR_NOT_FOUND`、`VERSION_NOT_FOUND`、`INVALID_CURSOR`、`INVALID_PAGE_LIMIT`；读路径不设独立禁用错误名（禁用状态 → `VENDOR_INACTIVE_OR_UNKNOWN`；更新路径的禁用更新错误见 VR-ERR-02）。

**VR-BR-01 追踪**

| VR-BR-01 义务 | AC |
|---|---|
| vendor 存在性单一权威 | VR-SNAPSHOT-02, VR-SNAPSHOT-03, VR-QUERY-01, VR-QUERY-07, VR-QUERY-08 |
| active/disable 单一权威 | VR-LIFE-02, VR-LIFE-07, VR-LIFE-08, VR-SNAPSHOT-02, VR-SNAPSHOT-03, VR-CLOCK-02, VR-SEC-07 |
| 消费方读 VR（非本地副本） | VR-SNAPSHOT-07, VR-SNAPSHOT-08 |
| NS 不查 VR | VR-SEC-04 |

**H1–H8 blocker 追踪**

| 修订 | 闭合义务 | AC |
|---|---|---|
| H1 | 唯一错误优先级 + 写/读闭合错误集 | VR-ERR-01, VR-ERR-02, VR-ERR-03 |
| H2 | register scope 与冲突保密 | VR-INTAKE-01, VR-INTAKE-07, VR-INTAKE-08, VR-INTAKE-09, VR-LIFE-07, VR-LIFE-08 |
| H3 | Delivery/历史结构投影分离 | VR-SNAPSHOT-01, VR-SNAPSHOT-04, VR-PROJ-01, VR-PROJ-02, VR-PROJ-03, VR-CRED-01, VR-CRED-08 |
| H4 | Header/auth/idempotency/body 交叉约束 | VR-POLICY-06, VR-POLICY-07, VR-POLICY-08, VR-POLICY-09, VR-POLICY-10 |
| H5 | ScopeFilter、闭合集合 item、稳定 cursor | VR-QUERY-16, VR-QUERY-17, VR-QUERY-18, VR-QUERY-19, VR-QUERY-20, VR-QUERY-21 |
| H6 | SSRF 输入阶段可达性 | VR-BL05-03, VR-BL05-04, VR-BL05-05, VR-URL-02 |
| H7 | 配置默认、范围、发布与治理 | VR-CFG-04, VR-CFG-05, VR-CFG-06, VR-CFG-07, VR-CFG-08, VR-CFG-09, VR-CFG-10, VR-CFG-11, VR-CFG-12, VR-CFG-13, VR-CFG-14 |
| H8 | confirmed rollback / outcome unknown | VR-CONCURRENCY-06, VR-CONCURRENCY-07, VR-CONCURRENCY-08 |

**I1–I6 blocker 追踪**

| 修订 | 闭合义务 | AC |
|---|---|---|
| I1 | 跨 scope 写错误模型对齐（`vendor_ids`→`FORBIDDEN` pre-lookup；`owning_scopes`→`VENDOR_NOT_FOUND` scope rejection） | VR-SCOPE-02, VR-SCOPE-03, VR-SCOPE-05, VR-AUDIT-06, VR-AUDIT-08 |
| I2 | `update_version` 凭证校验可达性 | VR-CRED-03 |
| I3 | CIDR 例外语义闭合（canonical network + same-AF intersection + prefix bound） | VR-BL05-04, VR-BL05-09, VR-CFG-15 |
| I4 | 端点配置契约闭合（`transport_kind` 派生；`body_field.field_name` charset；EndpointPolicy 2-set） | VR-URL-04, VR-POLICY-10, VR-POLICY-11 |
| I5 | `reject_reason` 闭合（7）+ 模糊 AC 错误映射 | VR-INTAKE-03, VR-INTAKE-05, VR-INTAKE-06, VR-SEC-05, VR-CRED-04, VR-ACTOR-01, VR-ACTOR-03, VR-ACTOR-04, VR-CLOCK-01, VR-AUDIT-08 |
| I6 | `owning_scope` + scope-set 规范化 | VR-INTAKE-10, VR-SCOPE-06, VR-QUERY-16 |

**J1–J3 blocker 追踪**

| 修订 | 闭合义务 | AC |
|---|---|---|
| J1 | `list_endpoint_versions`/`describe_vendor_state` 逐操作 ReadError 闭合（`INVALID_ACTOR_CONTEXT`/`FORBIDDEN`/`VENDOR_NOT_FOUND`/特权读取） | VR-QUERY-22, VR-QUERY-23, VR-QUERY-24, VR-QUERY-25 |
| J2 | snapshot 重复读字段级语义相等（替代响应字节相等；serialization 属 Architecture） | VR-PROJ-03, VR-IMM-04, VR-SNAPSHOT-04 |
| J3 | VR 合并状态权威 + 下游校正要求（NS 原暂定措辞 → Batch 4B-NS） | VR-SEC-07 |

**C1–C15 覆盖（全部 Applied）**

| C | VR AC 落点 |
|---|---|
| C1 | VR-INTAKE-01, VR-INTAKE-04, VR-ERR-01, VR-ERR-02, VR-ERR-03, VR-BL05-10, VR-BL05-11, VR-BL05-12, VR-CRED-03, VR-CRED-07, VR-ACTOR-01, VR-SCOPE-04, VR-URL-01, VR-URL-02, VR-URL-03, VR-POLICY-01, VR-POLICY-03, VR-POLICY-04, VR-POLICY-05, VR-POLICY-06, VR-POLICY-07, VR-POLICY-08, VR-POLICY-09, VR-POLICY-10, VR-ADMIN-01, VR-ADMIN-02, VR-CFG-01, VR-CFG-02, VR-CFG-03, VR-CFG-04, VR-CFG-05, VR-CFG-06, VR-CFG-07, VR-CFG-08, VR-CFG-09, VR-CFG-10, VR-CFG-11, VR-CFG-12, VR-CFG-13, VR-CFG-14 |
| C2 | VR-AUDIT-01, VR-AUDIT-02, VR-AUDIT-03, VR-AUDIT-04, VR-AUDIT-05, VR-AUDIT-06, VR-AUDIT-07, VR-INTAKE-09, VR-CONCURRENCY-07, VR-CONCURRENCY-08 |
| C3 | VR-IMM-02, VR-IMM-04, VR-MODEL-01, VR-PROJ-02, VR-PROJ-03 |
| C4 | worked example（见下） |
| C5 | VR-LIFE-01, VR-LIFE-02, VR-LIFE-03, VR-LIFE-04, VR-LIFE-05, VR-LIFE-06, VR-LIFE-07, VR-LIFE-08 |
| C6 | VR-SEC-01, VR-SEC-02, VR-SEC-03, VR-SEC-07, VR-SNAPSHOT-02, VR-SNAPSHOT-03, VR-SNAPSHOT-05, VR-QUERY-01, VR-QUERY-08, VR-QUERY-22, VR-QUERY-24, VR-SCOPE-02, VR-SCOPE-03, VR-ADMIN-03, VR-INTAKE-08, VR-INTAKE-09 |
| C7 | VR-CONCURRENCY-01, VR-CONCURRENCY-02, VR-CONCURRENCY-03, VR-CONCURRENCY-07, VR-CONCURRENCY-08 |
| C8 | VR-CONCURRENCY-04, VR-CONCURRENCY-05, VR-CONCURRENCY-06, VR-CONCURRENCY-08, VR-ADMIN-02, VR-ADMIN-03 |
| C9 | VR-ACTOR-01, VR-ACTOR-02, VR-ACTOR-03, VR-ACTOR-04, VR-AUDIT-01, VR-SCOPE-04, VR-PROJ-01 |
| C10 | VR-CLOCK-01, VR-CLOCK-02 |
| C11 | VR-ACTOR-02, VR-ACTOR-03, VR-ACTOR-04, VR-INTAKE-05, VR-INTAKE-06, VR-INTAKE-07, VR-LIFE-01, VR-LIFE-02, VR-LIFE-03, VR-LIFE-04, VR-LIFE-05, VR-LIFE-06, VR-LIFE-07, VR-SCOPE-01, VR-SCOPE-02, VR-SCOPE-03, VR-SCOPE-04, VR-ADMIN-01, VR-PROJ-01 |
| C12 | VR-QUERY-04, VR-QUERY-05, VR-QUERY-06, VR-QUERY-09, VR-QUERY-10, VR-QUERY-11, VR-QUERY-12, VR-QUERY-13, VR-QUERY-14, VR-QUERY-15, VR-QUERY-16, VR-QUERY-17, VR-QUERY-18, VR-QUERY-19, VR-QUERY-20, VR-QUERY-21 |
| C13 | VR-IMM-01, VR-CRED-06, VR-MODEL-01, VR-MODEL-02, VR-MODEL-03, VR-POLICY-02, VR-PROJ-02, VR-PROJ-03 |
| C14 | VR-SEC-01, VR-QUERY-04, VR-QUERY-06, VR-SEC-06, VR-SCOPE-01, VR-SCOPE-02, VR-SCOPE-03, VR-QUERY-12, VR-QUERY-16, VR-QUERY-22, VR-QUERY-24, VR-INTAKE-07 |
| C15 | VR-QUERY-04, VR-QUERY-05, VR-QUERY-09, VR-QUERY-10, VR-QUERY-11, VR-QUERY-12, VR-QUERY-13, VR-QUERY-14, VR-QUERY-15, VR-QUERY-16, VR-QUERY-17, VR-QUERY-18, VR-QUERY-19, VR-QUERY-20, VR-QUERY-21 |

**Worked example（C4，具体数值）**
1. `register(acme-prod)` → `record_revision=1`，`current_config_version=1`，两行（VendorRecord + EndpointVersion v1）；audit count 1；receipt count 1。
2. `activate` → `record_revision=2`，config_version 仍 1；audit/receipt 2/2。
3. 同时具备两项 Delivery capability 的 attempt A → `DeliveryConfigSnapshot` v1；历史读 → 无 locator 的 `HistoricalConfigSnapshot` v1。
4. `rotate_credential_ref` → `record_revision=3`，`current_config_version=2`；EndpointVersion v1 持久化字节不变（response 字段级语义相等）；audit/receipt 3/3。
5. Attempt A 可以用 v1 完成；下一个 attempt 解析权威 v2。
6. `disable` → `record_revision=4`，config_version 仍 2；audit/receipt 4/4。
7. 已发出的 HTTP 可完成；下一个未开始 attempt 获 `VENDOR_INACTIVE_OR_UNKNOWN`。
8. 特权历史读仍返回不可变 v1 和 v2。

## Open Questions / Deferred Implementation Decisions

> 已批准立场（PostgreSQL / opaque credential_ref / SSRF 数据-vs-运行时）**不是** Open Question。

**CDD blocker**：initial 8 blockers 已由 E1–E9 + F0 修订；re-review #1 的 7 个实现级 blocker 已由 G1–G7 修订；re-review #2 的 8 个实现级 blocker 已由 H1–H8 bounded revision 修订；re-review #3 的 6 个实现级 blocker 已由 I1–I6 bounded revision 修订；re-review #4 的 J1/J2/J3-VR 与独立 Batch 4B-NS 均已完成。fresh-session independent re-review #5 已 `APPROVED`，当前无未闭合 CDD blocker。

**Architecture deferred**：PostgreSQL schema/DDL/迁移 · KMS/Vault provider · credential_ref scheme/profile validator 内部 · allowlist 成员 · HTTP client/DNS resolver internals · URL parser / IDNA 细节 · 完整 CIDR runtime 算法 · 配置存储机制 · command_fingerprint canonical hashing 算法 · snapshot response wire serialization（canonical wire format）· hash-chain 审计 · timing 侧信道容差 · 语言/框架/驱动版本。

**Ratified contract**：snapshot 有效性 = per-attempt（Delivery 不绑定周期）· ingress/Delivery 消费契约形状。

**v1+ evolution**：bulk export · re-activation（需 amendment）· per-vendor SLO · wildcard hostname · SIEM split stream · AdminCommandReceipt retention/evolution · scheduled disable/activate。

## Boundary Traceability

> `VR-BR-01` 为局部可追踪义务（不重写 module-index 历史）。

| ID | 义务 | 正文落点 | AC |
|---|---|---|---|
| **VR-BR-01** | vendor 存在性/禁用 = VR 单一权威 | Overview + Core Spec B/C + States + Interactions + Edge Cases | VR-SNAPSHOT-02, VR-SNAPSHOT-03, VR-QUERY-01, VR-QUERY-07, VR-QUERY-08, VR-LIFE-02, VR-LIFE-07, VR-CLOCK-02, VR-SEC-04, VR-SEC-07 |
