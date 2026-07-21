# AI 使用说明

> **覆盖范围**：截至 2026-07-21 的需求分析、规格设计、审查、架构文档与 Pre-Implementation CP0 阶段。
> MVP 业务实现尚未开始；若后续使用 AI 编码或调试，最终提交前必须追加实现阶段记录。

## 使用原则

AI 用于加速拆解、提出候选方案和发现反例；项目所有者负责裁决系统边界、接受风险和批准约束。
AI 输出不会因“听起来完整”而自动成为决定：每项绑定决定需进入 T0、CDD、ADR 或所有者裁决记录。

## 可审计记录

| 阶段 | AI 提供的帮助 | 未采纳或人工修正 | 所有者决定与理由 |
|---|---|---|---|
| 问题拆解 | 把题目拆为接收、存储、投递、配置、运维、可观测性 | 拒绝把系统扩成工作流/事件平台 | 只做投递管道；业务 payload 与响应业务语义留在调用方 |
| 可靠性 | 比较 at-most/at-least/exactly-once，提出 outbox、重试、dead | 不采纳 exactly-once；拆开入站去重与出站重复风险 | at-least-once；同键异指纹 409；供应商重复风险公开 |
| 基础设施 | 比较 PostgreSQL、消息队列、SQLite/MySQL | 不采纳 Kafka/RabbitMQ day-1、双数据库实现 | PostgreSQL 单库 outbox，减少双写与运维面 |
| 失败恢复 | 提出重试、DLQ、自动恢复候选 | 不采纳无限重试和自动 dead 重放 | 25 次/24h 后 dead；仅授权人工重放 |
| 安全 | 提出端点 allowlist、SSRF 与 API Key 方案 | 初稿 SSRF 边界不足；补充 IPv4/IPv6、DNS rebinding、redirect | 调用方不可自定 URL；DNS pinning、no redirect、opaque credential ref |
| 模块设计 | 草拟六模块 CDD、AC 与跨模块数据流 | 拒绝按模块拆六个微服务；修正跨模块 context/错误漂移 | 六个逻辑模块、一个部署单元、Store/Registry 单一权威 |
| 反例审查 | 多轮检查幂等、lease、commit unknown、replay 和 deadline | 早期方案要求第二次 claim 完成 24h 终止，被反例推翻 | B-01：临界 attempt 在当前结果写回中原子 dead |
| 演进 | 提出多 worker、分片、多区域、circuit breaker | 不预排演进顺序，不引入 circuit-breaker 库 | 仅由 outbox age/depth、vendor 饱和和表增长等指标触发 |

## 明确未采纳的 AI 候选

1. **Exactly-once**：外部 HTTP 在超时/崩溃窗口不可证明；虚假承诺比公开重复风险更危险。
2. **Kafka day-1**：不能消除数据库事实写入，反而引入双写或 relay；当前没有流量证据。
3. **自动重放 dead**：可能在供应商持续异常时重复扩大副作用，必须保留人工裁决。
4. **微服务和多区域**：放大部署、鉴权、网络与一致性问题，不符合单人 MVP。
5. **响应驱动编排**：业务系统明确不关心返回值；这会把投递器变成工作流引擎。
6. **先上线后补监控**：不可观测的“可靠”不可证伪，三项核心信号必须 day-1 存在。

## 关键自主决策

- 签发 T0 v1.0，并把 PostgreSQL/API Key/SSRF 细节留在 Architecture/ADR，而不膨胀宪法。
- 选择 at-least-once、transactional outbox、dead 行即 DLQ、人工重放。
- 选择调用方构造业务 payload，服务只负责受控传输。
- 选择 Go 单体服务与 PostgreSQL，不建立 Kafka、Redis、独立任务平台。
- 裁决 Delivery B-01 为 actual-result 原子终止，而不是放宽 24h 承诺。
- 当前只完成文档体系，明确禁止伪造代码、测试、运行或发布证据。

## 证据入口

- T0 与签发：`../memory_bank/t0_core/basic_law_index.md`、`../memory_bank/t0_core/amendment_log.md`
- 模块与状态：`../design/cdd/module-index.md`
- B-01 裁决：`../design/cdd/reviews/delivery-deadline-adjudication.md`
- 逐模块复核与交叉复核：`../design/cdd/reviews/review-archive.md`（2026-07-21 合并归档）
- 架构包审查：`../architecture/architecture-review-archive.md`
- 阶段门禁：`../memory_bank/t3_archive/gate-archive.md`

## B1 工程基座与数据层（2026-07-21）

| 方面 | 记录 |
|---|---|
| AI 提供的帮助 | 生成 Dockerfile（多阶段 builder/app）、docker-compose（app + PostgreSQL 18.4）、B1 基础迁移 SQL（golang-migrate v4 风格）、`internal/config` 环境配置与 fail-closed pepper 处理、`internal/app` chi v5 路由骨架与优雅关闭、`cmd/server` 入口、以及对应单元/集成测试 |
| 未采纳或人工修正 | 未采纳单独 `outbox` 表（data-model.md 明确 pending/dead 行即 outbox/DLQ）；未在 B1 实现任何业务 AC 路径；未修改 `production/stage.txt`（无门禁运行） |
| 所有者决定与理由 | 所有者明确授权 B1 交付物；本地 shell 无 Go 工具链，依赖解析与编译验证通过 Docker 进行；若 Docker daemon 不可用，则记录环境限制并提交代码供后续 Go 环境验证 |

## B2 Notification Store 核心（2026-07-21）

| 方面 | 记录 |
|---|---|
| AI 提供的帮助 | 实现 `internal/notificationstore` domain（Repository 接口 8 方法、ActorContext/capability 矩阵、指纹与校验）与纯状态机 transition（succeed/retry/die/replay 判别联合）；PostgreSQL adapter（pgx/v5，SKIP LOCKED claim、OCC、append-only、HMAC 签名 cursor）；21 个单元用例（含 B-01 决策、6 项 policy_termination 计数规则、error_code 矩阵）与 10 个真实 PostgreSQL 集成用例（幂等矩阵、并发 claim、lease-holder、crash-after-send recovery、append-only 触发器、dead-list + replay、scoped outbox）；启动迁移接线 |
| 未采纳或人工修正 | AI 初稿 4 处真实缺陷由集成测试暴露并修复：迁移缺 `updated_at`/`replay_actor`/`replay_reason` 列（CDD §data model 有据）；intake 冲突路径误判（`pgx.ErrNoRows` 才是 ON CONFLICT DO NOTHING 的冲突信号）；recovery 循环 `conn busy`（pgx 单连接禁止交错查询，改为先物化）；scan NULL 列崩溃（改指针扫描）。未采纳 testcontainers（沿用 compose + DATABASE_URL skip 模式，不增依赖） |
| 所有者决定与理由 | Docker 验证命令经所有者批准；B2 测试全部在真实 PostgreSQL 18.4（compose）上跑 `-race`，不用 mock 数据库——CDD 对抗性纪律要求并发/触发器行为可证伪 |

## Pre-Implementation CP0（2026-07-21）

| 方面 | 记录 |
|---|---|
| AI 提供的帮助 | 撰写 full-jitter backoff leaf（`internal/delivery/backoff.go`）与表单驱动单测（`backoff_test.go`，stdlib-only）；起草 `go.mod` majors-only 骨架、`tests/` 布局与 `.github/workflows/tests.yml` CI；起草 `design/accessibility-requirements.md`（Basic tier） |
| 未采纳或人工修正 | 不采纳在 CP0 引入外部依赖——backoff leaf 保持 stdlib-only，使骨架在依赖解析前即可编译；不采纳本地伪造编译证据 |
| 所有者决定与理由 | 本地 shell 无 Go 工具链，骨架保持 authored-but-not-compiled，`go mod tidy` / `go test` 编译验证交由 CI 或 Go 环境完成；`go.sum` 与精确 patch 版本推迟到实现授权后解析，避免提前锁定；Architecture → Pre-Implementation gate 不运行（产出骨架 ≠ 运行门禁），stage 保持 Architecture |

