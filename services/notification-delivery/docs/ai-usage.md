# AI 使用说明

> **Imported historical record.**
>
> Imported history is retained for provenance.
> It is not the current OpenSlack roadmap, module status, runtime admission,
> release authority, or production-readiness source.

> **覆盖范围**：截至 2026-07-22 的需求分析、规格/架构文档，以及 B1–B6 实现、调试、演练与
> 机械验收。

## 使用原则

AI 用于加速拆解、提出候选方案和发现反例；项目所有者负责裁决系统边界、接受风险和批准约束。
AI 输出不会因“听起来完整”而自动成为决定：每项绑定决定需进入 T0、CDD、ADR 或所有者裁决记录。

## 可审计记录

| 阶段     | AI 提供的帮助                                               | 未采纳或人工修正                                            | 所有者决定与理由                                                    |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| 问题拆解 | 把题目拆为接收、存储、投递、配置、运维、可观测性            | 拒绝把系统扩成工作流/事件平台                               | 只做投递管道；业务 payload 与响应业务语义留在调用方                 |
| 可靠性   | 比较 at-most/at-least/exactly-once，提出 outbox、重试、dead | 不采纳 exactly-once；拆开入站去重与出站重复风险             | at-least-once；同键异指纹 409；供应商重复风险公开                   |
| 基础设施 | 比较 PostgreSQL、消息队列、SQLite/MySQL                     | 不采纳 Kafka/RabbitMQ day-1、双数据库实现                   | PostgreSQL 单库 outbox，减少双写与运维面                            |
| 失败恢复 | 提出重试、DLQ、自动恢复候选                                 | 不采纳无限重试和自动 dead 重放                              | 25 次/24h 后 dead；仅授权人工重放                                   |
| 安全     | 提出端点 allowlist、SSRF 与 API Key 方案                    | 初稿 SSRF 边界不足；补充 IPv4/IPv6、DNS rebinding、redirect | 调用方不可自定 URL；DNS pinning、no redirect、opaque credential ref |
| 模块设计 | 草拟六模块 CDD、AC 与跨模块数据流                           | 拒绝按模块拆六个微服务；修正跨模块 context/错误漂移         | 六个逻辑模块、一个部署单元、Store/Registry 单一权威                 |
| 反例审查 | 多轮检查幂等、lease、commit unknown、replay 和 deadline     | 早期方案要求第二次 claim 完成 24h 终止，被反例推翻          | B-01：临界 attempt 在当前结果写回中原子 dead                        |
| 演进     | 提出多 worker、分片、多区域、circuit breaker                | 不预排演进顺序，不引入 circuit-breaker 库                   | 仅由 outbox age/depth、vendor 饱和和表增长等指标触发                |

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
- 将 Vendor Registry 的 MVP `auth_strategy` 明确收窄为 `bearer`，拒绝把未实现的 HMAC/mTLS/custom
  配置写进公开契约；升级遇到既有非 bearer 数据时 fail closed。
- 接受 AI 辅助实现与测试，但不把同一线程机械自审写成 fresh independent `APPROVED`，也不伪造
  GitHub CI、性能、部署或发布证据。

## 证据入口

- T0 与签发：`../../../memory_bank/t0_core/basic_law_index.md`、`../../../memory_bank/t0_core/amendment_log.md`
- 模块与状态：`../design/cdd/module-index.md`
- B-01 裁决：`../design/cdd/reviews/delivery-deadline-adjudication.md`
- 逐模块复核与交叉复核：`../design/cdd/reviews/review-archive.md`（2026-07-21 合并归档）
- 架构包审查：`architecture/architecture-review-archive.md`
- 阶段门禁：`../../../memory_bank/t3_archive/gate_runs/notification-delivery.md`
- B1–B6 AC 证据：`testing/ac-evidence.json`、`../tests/contracts/ac_evidence_test.go`
- 实现评审：`../../../memory_bank/t3_archive/reviews/notification-delivery-implementation.md`

## 规划输入与实际偏差

> **Historical / non-authoritative**：本节只记录 B1/B2 完成后、B3/B4 实施前的 AI 辅助规划输入及其
> 后续裁决，不覆盖 CDD、ADR、OpenAPI、当前开发计划、代码或验收证据。

三份原始草稿位于本地忽略的 `.claude/`，不随仓库提交，也不作为后续同步源。本节只保留能说明
工程判断的计划假设、实施偏差与结果；SQL 草图、文件清单、包布局、逐 AC 表、工作量估算、待办项和
“授权后下一步”均不复制。

### 输入溯源

| 历史输入                   | 形成时间   | 原始 SHA-256                                                       | 当时用途                                                |
| -------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `.claude/b3-b6-recon.md`   | 2026-07-21 | `d7789caff9152a5a8d962612446ea082e739f2542ec72338632df07669254a69` | 在 B1/B2 完成后汇总 B3–B6 范围、依赖和控制约束          |
| `.claude/plans/b3-plan.md` | 2026-07-21 | `50db46a95f1f6f1034b03326f27279c3f10d0e40fc745341531e67ce5c9b4cf7` | 规划 Caller Access、Vendor Registry、路由、迁移与测试   |
| `.claude/plans/b4-plan.md` | 2026-07-21 | `a5d97799d08215bd23ffa319f6b73d42f2c9b0a65057fdab7429854a9cd08804` | 规划 Delivery、SSRF-safe transport、B-01、worker 与测试 |

### 计划到实施的收敛

| 输入                 | 实际采纳                                                                                                     | 人工修正或拒绝                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B3–B6 reconnaissance | 保留单体、PostgreSQL 单一事实源、六个逻辑模块、290 AC + 4 NSBR 和公开契约边界                                | 实际包名收敛为 `operationscontrol`、`reliability`；指标直接输出 Prometheus text exposition，不引入计划草稿中的 `client_golang`                             |
| B3 计划              | 落地 API Key digest/pepper、scope attenuation、Vendor version、receipt/audit、闭合路由与真实 PostgreSQL 测试 | MVP 收窄为 bearer-only；按 CDD 修正错误映射、数据库锁和限流；测试改为进程独立 schema；不增加 key-admin HTTP API                                            |
| B4 计划              | 落地 B-01、DNS 双解析、pinned-IP TLS、no proxy/no redirect、request builder、runner 和有界 worker 生命周期   | attempt 联合约束使用前向 `000004` migration；禁止读取或 drain 响应体；Resolver/dialer 可注入；固定 worker pool 取代跨 tick goroutine；不增加第四项业务指标 |

### B4 未决项的最终裁决

1. `delivery_attempts` 的 result/outcome/reason 联合由 `000004_b4_delivery_result_contract` migration
   约束，未回写或静默扩大早期 migration。
2. 出站认证仅实现 `bearer`；HMAC、mTLS、AWS SigV4 与 custom 不进入 MVP 公开契约。
3. worker health event 只保留去敏事件；可靠性表面固定为三项全局 gauge，不增加 counter。

最终事实以[当前开发计划](development-plan.md)、[实现评审档案](../../../memory_bank/t3_archive/reviews/notification-delivery-implementation.md)
和 [AC 证据清单](testing/ac-evidence.json)为准。下面的 B3/B4 章节记录实际实现与人工修正，不重复上述
历史计划正文。

## B1 工程基座与数据层（2026-07-21）

| 方面             | 记录                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 生成 Dockerfile（多阶段 builder/app）、docker-compose（app + PostgreSQL 18.4）、B1 基础迁移 SQL（golang-migrate v4 风格）、`internal/config` 环境配置与 fail-closed pepper 处理、`internal/app` chi v5 路由骨架与优雅关闭、`cmd/server` 入口、以及对应单元/集成测试 |
| 未采纳或人工修正 | 未采纳单独 `outbox` 表（data-model.md 明确 pending/dead 行即 outbox/DLQ）；未在 B1 实现任何业务 AC 路径；未修改 `production/stage.txt`（无门禁运行）                                                                                                                |
| 所有者决定与理由 | 所有者明确授权 B1 交付物；本地 shell 无 Go 工具链，依赖解析与编译验证通过 Docker 进行；若 Docker daemon 不可用，则记录环境限制并提交代码供后续 Go 环境验证                                                                                                          |

## B2 Notification Store 核心（2026-07-21）

| 方面             | 记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 实现 `internal/notificationstore` domain（Repository 接口 8 方法、ActorContext/capability 矩阵、指纹与校验）与纯状态机 transition（succeed/retry/die/replay 判别联合）；PostgreSQL adapter（pgx/v5，SKIP LOCKED claim、OCC、append-only、HMAC 签名 cursor）；21 个单元用例（含 B-01 决策、6 项 policy_termination 计数规则、error_code 矩阵）与 10 个真实 PostgreSQL 集成用例（幂等矩阵、并发 claim、lease-holder、crash-after-send recovery、append-only 触发器、dead-list + replay、scoped outbox）；启动迁移接线 |
| 未采纳或人工修正 | AI 初稿 4 处真实缺陷由集成测试暴露并修复：迁移缺 `updated_at`/`replay_actor`/`replay_reason` 列（CDD §data model 有据）；intake 冲突路径误判（`pgx.ErrNoRows` 才是 ON CONFLICT DO NOTHING 的冲突信号）；recovery 循环 `conn busy`（pgx 单连接禁止交错查询，改为先物化）；scan NULL 列崩溃（改指针扫描）。未采纳 testcontainers（沿用 compose + DATABASE_URL skip 模式，不增依赖）                                                                                                                                   |
| 所有者决定与理由 | Docker 验证命令经所有者批准；B2 测试全部在真实 PostgreSQL 18.4（compose）上跑 `-race`，不用 mock 数据库——CDD 对抗性纪律要求并发/触发器行为可证伪                                                                                                                                                                                                                                                                                                                                                                    |

## B3 Caller Access + Vendor Registry（2026-07-21）

| 方面             | 记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 实现 `internal/calleraccess`（API-key Bearer 认证、HMAC-SHA-256 digest、pepper versioning、revocation、scope attenuation、principal derivation 拒绝自报 caller_id）、`internal/vendorregistry`（vendor/endpoint 版本管理、admin command 幂等 receipt、admin audit events、append-only endpoint_versions、latest_active snapshot、anti-enumeration 404）、`internal/app` 公开路由接线与错误映射；`internal/calleraccess/postgres` 与 `internal/vendorregistry/postgres` 真实 PostgreSQL 适配器；新增 `internal/calleraccess/postgres`、 `internal/vendorregistry`、 `internal/vendorregistry/postgres`、 `internal/app/handler_test.go`、 `tests/integration/calleraccess_test.go`、 `tests/integration/vendorregistry_test.go` 等测试；修正 `migrations/000003_b3_registry_fixes.*.sql` 以补齐 endpoint_versions 缺失列 |
| 未采纳或人工修正 | 未采纳计划中的 `SERVICE_UNAVAILABLE` 读错误码（按 CDD 闭合为 `VENDOR_INACTIVE_OR_UNKNOWN`/`VENDOR_NOT_FOUND`/`VERSION_NOT_FOUND`）；修正 `FOR UPDATE` 与聚合函数冲突（改用 principals 行锁串行化 active-key 上限）；修正 rate limiter 桶容量误用 rate 导致低配额首请求被拒；修正 `regexp` 重复次数超过 Go 上限；修正 endpoint_policy CIDR 序列化与 JSON tag 缺失；修正 UUID 空字符串游标比较错误；未在 B3 实现 key admin HTTP 端点（计划外）                                                                                                                                                                                                                                                                                                                                                                            |
| 所有者决定与理由 | 所有者授权 B3 实施；不接受用 `-p 1` 隐藏跨包数据库死锁，改为每个测试进程独立 PostgreSQL schema，使默认并行 `go test -race ./... -count=5` 稳定通过；公开 wire 必须由 OpenAPI request/response validator 实证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## B4 Delivery（2026-07-22）

| 方面             | 记录                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 实现并加固 request builder、credential reference、SSRF address policy、两次 DNS 解析与地址集一致性、pinned-IP transport、原 hostname TLS/SNI、no proxy/no redirect/no body drain、attempt classifier、B-01 runner、固定并发 worker pool 与有界 shutdown；补充 domain/transport/runner/worker 测试及真实 PostgreSQL + Vendor Registry + Store 端到端测试 |
| 未采纳或人工修正 | 未采纳把 Resolver 隐藏在 transport 内而无法确定性测试的方案；未采纳读取或 drain 任意供应商响应体；拒绝 private/reserved/documentation/benchmark/CGNAT/IPv4-mapped IPv6；修正跨 tick goroutine 扩张、signal context 接线和结果提交被 shutdown 取消的问题                                                                                                 |
| 所有者决定与理由 | 保持单进程单二进制与 PostgreSQL 单一事实源；pre-send deadline 使用不计数 `policy_termination`，已发送的临界 HTTP/transport 结果按 B-01 保存实际结果、attempt +1 并在同一事务原子进入 dead                                                                                                                                                               |

## B1–B4 验收闭合（2026-07-22）

| 方面             | 记录                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI 提供的帮助    | 修复 B3 统一 envelope、必填 Idempotency-Key、202 `accepted_at` 与稳定错误码；把 `auth_strategy` 收窄为 bearer 并加入前向迁移约束；补 Store clock/commit/cursor/page/lease/result-union 证据；加固 VR URL/CIDR/Header/config 联合、签名且 scope-bound cursor、拒绝审计联合与 snapshot 上限；建立 NS 79 + CA 15 + VR 152 + DL 20 = 266 项 AC 的显式机器登记与测试函数存在性检查；配置 PostgreSQL 18.4 CI |
| 未采纳或人工修正 | 不接受旧评审中的 `code-only`/deferred 作为完成证据；不通过关闭 Go 包并行来绕过数据库争用；不把 family 测试函数清单本身等同于 266 项显式登记或独立评审；不静默改写既存非 bearer 版本；不声称 GitHub Actions 已运行                                                                                                                                                                                      |
| 所有者决定与理由 | B1–B4 范围内所有 AC 必须映射到实际测试，默认并行 race 连续 5 次通过；旧 B3 `NEEDS REVISION` findings 逐项修复。当时自审状态停在 `READY FOR INDEPENDENT REVIEW`；随后 B1/B2、B3、B4 fresh independent review 均已 Approved                                                                                                                                                                              |

## B5–B6 实现与全量验收（2026-07-22）

| 方面             | 记录                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 实现六条 Operations API、闭合投影与 best-effort replay；实现单快照 reliability collector、三 gauge 与 Prometheus 状态规则；接入 recovery advisory lock、pepper generation fail-closed、生命周期和 production image；生成并执行 crash-after-send、数据库重启、deadline backlog、容量、pepper 与加密 PITR 演练                                                                                                                            |
| 未采纳或人工修正 | 不引入 Alertmanager、第四项业务指标、自动 replay、key-admin HTTP/CLI、Kafka/Redis；Prometheus 初始规则没有正确重置 pending timer，按时序测试修正；PITR 初稿失败均保留为失败记录，最终改为真实 fixture + 业务不变量恢复；独立评审发现 OC capability/scope、RO-04 证据链、N=W 持久化、relation growth 与重复 pepper generation ID 缺口后逐项补齐；Compose migration URL 的 `postgres`/`pgx5` driver mismatch 由实际启动暴露后修复         |
| 所有者决定与理由 | 每次 scrape 只读一次 Store且失败整体 503；独立终审发现 Store 曾把负 oldest age clamp 为 0，会绕过 fail-closed，人工裁决为移除 clamp 并增加真实 PostgreSQL 回归；firing 后 scrape failure 采用自保持，仅成功 dead=0 恢复；恢复器每周期一批并以 transaction advisory lock 单例；本地数值只作 evolution baseline，不写为 SLA；逐批及最终 cross-batch re-review 均已 Approved；GitHub CI 未运行，不把本地 submission-ready 扩大表述为已部署 |

## CP0 测试基线（2026-07-21，历史记录）

| 方面             | 记录                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 提供的帮助    | 撰写 full-jitter backoff leaf（`internal/delivery/backoff.go`）与表单驱动单测（`backoff_test.go`，stdlib-only）；起草 `go.mod` majors-only 骨架、`tests/` 布局与 `.github/workflows/tests.yml` CI；起草 `design/accessibility-requirements.md`（Basic tier）                       |
| 未采纳或人工修正 | 不采纳在 CP0 引入外部依赖——backoff leaf 保持 stdlib-only，使骨架在依赖解析前即可编译；不采纳本地伪造编译证据                                                                                                                                                                       |
| 所有者决定与理由 | 本地 shell 无 Go 工具链，骨架保持 authored-but-not-compiled，`go mod tidy` / `go test` 编译验证交由 CI 或 Go 环境完成；`go.sum` 与精确 patch 版本推迟到实现授权后解析，避免提前锁定；Architecture → Pre-Implementation gate 不运行（产出骨架 ≠ 运行门禁），stage 保持 Architecture |
