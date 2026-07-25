# System Patterns

> T1 supporting context。支持 T0 法律的结构细节。权威模块边界来源：`../../design/cdd/module-index.md`。
> 不写 ADR 算法、SQL/DDL、包结构或框架 API（Architecture / ADR deferred）。

## Architectural Style

- **Primary style**：transactional outbox + worker（BL-03）
- **Delivery semantics**：at-least-once；入站强去重（`request_fingerprint` 冲突 → `409 IdempotencyConflict`）；出站重复为公开风险（BL-02）
- **边界**：投递管道，仅向已批准端点投递；防 SSRF（BL-05）

## Delivery Semantics

- at-least-once；永不 exactly-once（BL-02）。
- 入站强去重：`(caller_id, Idempotency-Key)` 复合唯一 + 不可变 `request_fingerprint`；同键同指纹→同一
  `notification_id`（幂等），同键异指纹→`409 IdempotencyConflict`，不新增状态。
- `caller_id` 服务端推导（认证记录），不接受请求自报。
- 出站幂等键映射**端点配置驱动**（`idempotency_header`/`idempotency_body_field`，缺省不写入）；出站重复为
  公开风险，接入文档须声明。
- 指纹规范化算法 → 幂等 ADR。

## Transactional Outbox

- 入站接收 + "可投递可见性" 在**同一数据库事务**原子完成；outbox 表是唯一真相源（BL-03）。
- 禁止"先写库再写队列"双写，除非队列由 outbox relay 喂入。
- 并发认领方向：`FOR UPDATE SKIP LOCKED`（PostgreSQL 已批准方向）；具体 SQL/锁机制 → ADR。
- 所有投递状态 = 该表 status 列。

## Retry and DLQ

- 有界重试：`MAX_ATTEMPTS` + `MAX_AGE` + full-jitter 退避均归 Delivery；Store 只接收
  Delivery 已判定的规范化 transition result，不接收或持久化 `policy_inputs`。
- 超限→显式 `dead` 状态；dead 行即 DLQ，不引入独立死信基础设施（BL-04）。
- 无自动 dead→pending；重放仅人工触发（单条/批量/dry-run，授权 + justification）。
- Notification Store 只持久化 attempt/age/next-attempt 状态 + 保护合法转换；不持常量值。

## Scope Boundary

- 投递管道，非业务处理器（BL-05）：出站不读响应体业务字段（仅 HTTP status + retry-relevant header 如
  `Retry-After`）；ingress 仅校验闭合 JSON 结构字段清单（`SCHEMA_FIELDS`），畸形 JSON 拒、其余接受。
- 调用方按 vendor 格式自构 payload；服务不做字段映射/模板/schema 转换。
- 目标地址仅取自 `vendor_endpoints`（已批准）；调用方只引用 `vendor_id`，不得指定 URL。
- non-goal：响应驱动分支、跨通知排序、深度 payload 校验、任意目标地址代理。

## SSRF Prevention

- 默认强制 HTTPS；**默认禁止所有非公网地址**（IPv4/IPv6 私网/回环/链路本地/组播/保留/ULA/非全局）。
- 企业内网供应商按 vendor 显式 `hostname + port + CIDR` 例外。
- **连接前校验 A/AAAA 解析结果**（DNS pinning，防 DNS rebinding）；**默认不跟 HTTP 重定向**。
- **运行时执行归 Delivery**（解析/重解析/IP 校验/pinning/连接/no-redirect）；Vendor Registry 只拥有受控目标
  + 例外**策略数据**。
- 完整 CIDR 清单、解析校验算法、重定向策略 → SSRF ADR（`/setup-engine` 后）。

## Module Boundaries

> 以 `../../design/cdd/module-index.md` 为权威（6 模块 / 5 依赖边 / DAG）。此处为摘要镜像。

| Module | Responsibility | Owns | Communicates via |
|--------|----------------|------|------------------|
| Notification Store | 通知持久化、原子接收、状态机、attempt 历史、并发 lease | notification 状态、lease、attempt history | `ValidatedIntake` 接收；`claim`/`transition_request`（succeed/retry/die/replay）/`recover`/`query` |
| Vendor Registry | 已批准端点记录、静态凭证、传输/认证 Header、幂等键映射、vendor existence/active | vendor 配置 | ingress composition 调用 |
| Caller Access | API Key→`caller_id`、key→`vendor_id` scope、限流 | caller identity + vendor scope | ingress composition 调用 |
| Delivery | 出站 HTTP、SSRF 行为、重试/死信策略（25/24h、full-jitter）、单次 HTTP 尝试 | HTTP attempt、retry/dead policy | `claim`/`transition_request` 消费 Store |
| Operations Control | 状态查询、受守护人工重放（单条/批量/dry-run） | guarded replay/query | Store `query` + `transition_request(replay)` |
| Reliability Observability | outbox 深度、最老 pending 年龄、dead 计数、告警语义 | 三项 MVP 信号 | Store global `query_outbox` 只读 |

## Data Ownership Rules

- outbox 表（Notification Store）是投递状态的**唯一真相源**（BL-03）。
- Notification Store 拥状态机、lease、append-only attempt history、delivery cycle 元数据。
- Delivery 拥重试/死信策略（`MAX_ATTEMPTS`/`MAX_AGE`/full-jitter/deadline 判定）。
- Vendor Registry 拥 vendor existence / active / endpoint config 单一权威。
- Caller Access 拥 caller identity + key→vendor scope。
- Store **不**向 Caller Access / Vendor Registry 发运行时出站查询（静态组合前置条件）。

## Binding Cross-Module Contracts

- `delivery_result.result_kind`（Notification Store）与 Delivery 的结果矩阵已双向确认。
- `claim` 返回的 cycle 元数据（`attempt_count`、`delivery_cycle_started_at`、`created_at`）已双向确认。

## Approved Contract Guardrails

> 跨模块护栏（NS 4 轮复审固化）。精确契约以各模块 Approved CDD 为权威；本节为指针，不复制字段矩阵。

- **Actor scope/capability 矩阵**（C11）：受保护操作校验 actor kind × scope × capability，非仅 ownership。
- **服务端权威时间**（C10）：安全/调度相关时间不用调用方提供的 `now`；异常 fail-closed。
- **有界 collection 查询**（C12）：无界 list/history 用游标分页 + page cap；singleton/固定聚合不强制分页。
- **Confirmed rollback vs outcome unknown**（C8）：提交结果未知的操作区分两类 + 各自收敛路径。
- **Scoped/global 读模型隔离**（C14）：scoped vs global 聚合分离；global 显式授权。

## Pattern Notes

架构或模块边界变化时更新本文件；同步 `../../design/cdd/module-index.md`。
