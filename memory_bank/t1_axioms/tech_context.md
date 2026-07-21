# Tech Context

> T1 supporting context。只记录已批准或当前可验证事实；实现仍未开始。
> 权威来源：T0 `../t0_core/basic_law_index.md`、`../t0_core/active_context.md`、`../../design/cdd/notification-store.md`。

## Domain / Platform

- **Domain**: Product（通用产品）
- **Platform**: 内部 headless server product（无终端用户 UI）；单 region 多 AZ 部署方向

## Technology Stack

| Layer | Choice | Version | Rationale |
|-------|--------|---------|-----------|
| Storage | PostgreSQL | 18.4 | 唯一持久状态；outbox + vendor 配置 + 状态查询 + dead；`FOR UPDATE SKIP LOCKED` |
| Language | Go | 1.26.5 | 单二进制、标准 HTTP/transport、明确并发生命周期 |
| HTTP router | chi | v5 | 轻量路由边界；实施时固定最新稳定 patch |
| Driver | pgx | v5 | PostgreSQL-native transaction/locking；实施时固定最新稳定 patch |
| Migration | golang-migrate | v4 | forward migration baseline；实施时固定最新稳定 patch |

## Technology Decision Record

- **PostgreSQL（已批准）**：单库承载 outbox + vendor 配置 + 状态查询 + DLQ；`FOR UPDATE SKIP LOCKED` 取任务。
  来源：`../t0_core/active_context.md` Approved Architecture Decisions、BL-03。
  排除：SQLite（不作并发 worker 生产替代）、MySQL（技术上可行但无足够收益保留双实现）。
- **Language / framework / driver**：Go 1.26.5 + chi v5 + pgx v5 + golang-migrate v4。
  实施授权后从官方 release 固定各依赖的最新稳定 patch；当前不创建 `go.mod`。
- **Knowledge risk**：LOW-MEDIUM — 栈已选；SSRF pinned-dial、迁移和并发仍须未来测试证明。
- **参考文档**：`../../standards/technical-preferences.md`、`../../docs/architecture/`。

## Performance Budgets

- **当前没有批准的数值性能预算**（latency / throughput / memory ceiling 均未裁决）。
- BL-06 的 outbox 深度、最老 pending 年龄、dead 计数是**运营可靠性指标**，不是性能预算。
- 数值目标、负载模型与 measurement method 在实现前通过 Architecture + load test 决定（BL-01）。

## External Dependencies

| Dependency | Purpose | Version | Risk if unavailable |
|------------|---------|---------|---------------------|
| PostgreSQL | outbox + vendor 配置 + 状态 + dead 持久化 | 18.4 | 不可用时 intake/worker fail closed；无本地 fallback |
