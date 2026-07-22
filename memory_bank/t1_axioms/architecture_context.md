# Architecture Context

> T1 supporting context。架构决策与组件所有权的索引层；不替代 `../../docs/architecture/architecture.md` 或
> `../../docs/architecture/adr-*.md`（权威源）。Architecture 事实仍以已独立审查版本为准；
> B1–B6 已实现，证据另见 `../../docs/testing/ac-evidence.json`。

## Architecture Summary

- **架构文档**：`../../docs/architecture/architecture.md`（独立审查 PASS 2026-07-20）
- **当前架构状态**：Approved（Current stage = Implementation；B1–B6 mechanically verified；逐批及 final cross-review Approved；local submission-ready）
- **栈**：Go 1.26.5 + chi v5 + pgx v5 + golang-migrate v4；PostgreSQL 18.4（见 `tech_context.md`）
- **形态**：单二进制单进程；多副本与行锁/lease 兼容但非 day-1；逻辑模块非独立可部署服务
- **核心承诺**：提交即忘、可靠送达——at-least-once + 有界重试（25 次 / 24h）+ 可查询 + 受守护人工重放
- **关键架构风险**：SSRF/DNS rebinding/重定向/IPv6 全覆盖；API Key 为 MVP 唯一认证防线；并发 `SKIP LOCKED` 与 lease 正确性

## Component Ownership

> 权威：`../../docs/architecture/architecture.md`（Component Ownership）。聚合→表归属见 `../../docs/architecture/data-model.md`。

| Component | Owns | Exposes | Consumes |
|---|---|---|---|
| Caller Access | principals、key digests、capabilities、vendor scope、rate counters | authenticate/authorize/context attenuation | key repository、clock |
| Vendor Registry | vendor lifecycle、endpoint versions、receipts、admin audit | active check、latest/specific snapshot、admin/read ops | PostgreSQL |
| Notification Store | notification、lease、attempt history、replay、query projections | accept/claim/transition/recover/query | PostgreSQL |
| Delivery | retry/dead 决策、safe request 构造、单次 HTTP attempt | worker lifecycle only | Store、Registry、secret resolver、safe transport |
| Operations Control | query/preview/execute composition | operator HTTP behavior | Caller Access、Store |
| Reliability Observability | 三项 gauge + 告警语义 | `/metrics` projection | Store global query |
| App lifecycle | dependency 构造、startup/readiness/shutdown | process lifecycle | all ports |

规则：除 owner 外任何组件不得写其拥有的表；跨模块调用走进程内 typed interface（BL-03 / CTRL-004/005）。

## Load-bearing Decisions

- **PostgreSQL + transactional outbox（ADR-0001）**：PostgreSQL 18.4 为唯一持久真相与协调权威；intake/可见性/lease/状态/append-only attempt 原子耦合；worker 用 `FOR UPDATE SKIP LOCKED` 认领；pending 行即 outbox，dead 行即 DLQ（BL-03）。
- **At-least-once + 入站强去重（ADR-0002）**：`(caller_id, Idempotency-Key)` 复合唯一 + 不可变 `request_fingerprint`（SHA-256，versioned length-prefixed）；同键同指纹→原通知 + `202`，同键异指纹→`409`；出站 at-least-once，重复为公开风险（BL-02）。
- **API Key + pepper（ADR-0003）**：`key_id.secret`；仅持久化 `HMAC-SHA-256(pepper_for(pepper_id), full_key)` + 非密 `pepper_id`；constant-time 比较；`Bearer` 为唯一业务/admin 认证；principal kind/scope/capability 仅来自权威记录；每 principal ≤2 active keys。2026-07-20 pepper-lifecycle 修订：`API_KEY_PEPPER_ACTIVE`/`_PREVIOUS` 双代（active + optional previous grace）、routine rotation + drain 前置、emergency bulk-revoke、pepper-loss fail-closed；pepper value 为 CTRL-016 secret（BL-02/05）。
- **SSRF-safe HTTP（ADR-0004）**：调用方仅提交 `vendor_id` + payload；Registry 拥有 canonical scheme/host/port/path/Header 策略；强制 HTTPS；解析全部 A/AAAA 并校验策略；dial 单个 pinned `netip.Addr` + 原始 TLS `ServerName`；禁 env proxy、重定向一律失败；仅读 status + 有界 `Retry-After`，不读响应体（BL-05）。

## Lease / OCC / Recovery

- Intake / Claim（`FOR UPDATE SKIP LOCKED` + lease）/ Result（OCC + lease 校验）/ Replay / Vendor admin 各自单事务原子（`architecture.md` Persistence and Transactions）。
- B-01 截止收敛：retryable attempt 在 `cycle_send_cutoff` 之后完成 → Delivery 在当前 Store write 提交 `die(permanent_failure, deadline_exceeded)`；Store 保留 status/error、attempt 计一次、清 lease、入 `dead`，原子完成（CTRL-006）。no-send cutoff 为非计次 `policy_termination`（CTRL-007）。
- 无 lease renewal；无本地磁盘 fallback（CTRL-020）。PostgreSQL 事务时间为权威时间；commit 区分 confirmed rollback vs outcome unknown（CTRL-012 / C8）。

## Configuration and Secrets

> 权威：`architecture.md` Configuration and Secrets + ADR-0003 pepper-lifecycle 修订。

- 配置在 startup 一次性加载并按 generation 校验。
- Pepper：`API_KEY_PEPPER_ACTIVE={id,value}` + optional `API_KEY_PEPPER_PREVIOUS={id,value}`；均经 startup `env://`-allowlist 加载；改动需 restart；pepper value 为 CTRL-016 secret，仅非密 `pepper_id` 持久化于 `access_keys`。
- Registry 仅持久化 `env://NAME`；secret resolver 仅接受 allowlist 内名称，字节直返 attempt-scoped buffer；secret value 永不进入 Store/logs/metrics/audit/responses（CTRL-016）。

## Failure Model

> 权威：`architecture.md` Failure Model。此处为指针。

- PostgreSQL 不可用 → readiness false、intake 503、worker 停止认领、无 fallback（CTRL-020）。
- commit rolled back → 显式可重试拒绝，无状态；commit outcome unknown → 幂等 re-query/retry 收敛。
- 进程 crash after send → lease recovery 记 unknown，at-least-once 可能重复。
- vendor transient → 计次重试（full-jitter）；vendor permanent/policy → 计次 actual-result 或非计次 pre-send `dead`。
- DNS/私网/重定向违规 → fail closed，不发二次请求；credential 不可用 → 无网络，稳定 policy termination。

## Evolution Boundaries

- 仅当 age/depth 测量证明需要时加 worker 并发或 LISTEN/NOTIFY；单 vendor 饱和时加 vendor fairness；表维护退化时 retention/partition；存在共享 IdP 时更强身份。
- Kafka / sharding / 多区域需测量需求 + 新 ADR；多区域另需 T0 amendment（BL-01 演进）。

## ADR Support Map

> 权威：`../../docs/architecture/adr-registry.yaml`。BL 映射见 `../../docs/architecture/control-manifest.md`。

| ADR | Status | Supports T0 law(s) | Notes |
|---|---|---|---|
| [ADR-0001](../../docs/architecture/adr-0001-postgresql-outbox.md) | Accepted | BL-03 | outbox 原子性、PostgreSQL 唯一真相、SKIP LOCKED/lease/OCC、append-only attempt+audit |
| [ADR-0002](../../docs/architecture/adr-0002-idempotency-at-least-once.md) | Accepted | BL-02、BL-03 | 指纹去重 + 202/409、出站 idempotency 映射、重复披露 |
| [ADR-0003](../../docs/architecture/adr-0003-api-key-authorization.md) | Accepted | BL-02、BL-05 | HMAC+pepper 存储、服务端推导 ActorContext、scope/capability attenuation、rotation/revocation、pepper lifecycle（2026-07-20 修订） |
| [ADR-0004](../../docs/architecture/adr-0004-ssrf-safe-http.md) | Accepted | BL-05 | Registry-only 目标 + secret ref、全地址校验 + DNS pinning、禁代理/拒重定向、原始 host TLS + 不读响应体 |

## Notes

架构决策或 ADR 状态变化时更新本文件；同步 `../../docs/architecture/architecture.md` 与 `../../docs/architecture/adr-registry.yaml`。
