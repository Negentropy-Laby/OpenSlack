# Active Context — T0 Core

> 项目当前工作状态快照。与 `basic_law_index.md` 配套；宪法的批准与修订记录在此登记。

## Repo Status
- **Project**: `rc_wsman` — API 通知投递服务（内部系统，作业项目）
- **Current working state**: Architecture 阶段 — 6/6 CDD Approved；Delivery B-01、公开
  `payload_base64` wire 与 Vendor method source 均已 fresh focused review APPROVED；entity/trace registry
  已通过 consistency/cross-review run 03；Specification → Architecture gate PASS；
  Architecture package 独立审查 APPROVED；实现尚未开始，等待新的授权。架构审查的两项 Non-Blocking Advisory
  已在 Architecture 范围闭合（ADR-0003 pepper 生命周期 + deadline backlog 分析；fresh 独立 re-review APPROVED
  `docs/architecture/architecture-review-archive.md`；deployment-package 实例化与 Pre-Impl
  证明仍待后续阶段）。2026-07-21 经所有者授权完成文档 consolidation：逐模块 review log、cross-review、
  gate run 与 architecture review 原件已合并归档（`design/cdd/reviews/review-archive.md`、
  `docs/architecture/architecture-review-archive.md`、`memory_bank/t3_archive/gate-archive.md`），
  占位文件 `release_state.md` 与 `production/session-state/` 已退役
- **Layer model**: `T0 (laws) -> T1 (support) -> T2 (execution) -> T3 (archive)`

## Core Thesis
一个"只投递、不处理"的内部服务：持久化接收内部业务系统提交的出站 HTTP 通知请求，
按 at-least-once 语义投递至**已配置并批准的**供应商端点，具备有界重试、可查询的死信状态
与人工重放。

**Anti-thesis（本项目明确不是什么）:**
- 不是消息队列 / 流处理平台（不引入 Kafka 作为骨干）
- 不是工作流引擎（不依据供应商返回值做业务分支）
- 不承诺 exactly-once 投递
- 不是多区域 active-active 系统
- 不是开放 HTTP 代理（不向任意调用方指定地址投递）

## Constitution Version
- **Version**: 1.0 (Accepted)
- **Last amended**: 2026-07-18
- **Last sign-off**: 2026-07-18 by 项目所有者

## Active Decisions（已绑定于宪法法律层 · BL-01..BL-06 Accepted）
- **投递语义**：at-least-once；**入站强去重**（含 `request_fingerprint` 冲突 → 409）；出站
  重复为公开风险（BL-02）
- **持久化原子性**：transactional outbox 模式 + 单一真相源（BL-03）
- **死信**：dead 行即 DLQ，无独立基础设施；重放仅人工触发（BL-04）
- **边界与安全**：投递管道 + 仅向已批准端点投递 + 防 SSRF（DNS pinning + 不跟重定向）（BL-05）
- **可观测性**：outbox 深度 / 最老 pending 年龄 / dead 计数 day-1（BL-06）
- **演进**：由观测指标触发，不提前锁定具体架构（BL-01）

## Approved Architecture Decisions（已批准 · 细节进 ADR / T1，非 T0 法律）
> 按签发意见，以下决定不写入 T0 法律，仅在此登记；完整理由与规范随后进 ADR / T1。

- **存储 = PostgreSQL** —— 同库承载 outbox + vendor 配置 + 状态查询 + DLQ；worker 用
  `FOR UPDATE SKIP LOCKED` 取任务（[PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html)）。
  SQLite 不作并发 worker 生产替代；MySQL 技术上可行但无足够收益保留双实现。
- **调用方认证 = API Key（MVP）** —— `caller_id` 服务端推导；仅存哈希，日志只记 key ID /
  caller ID；支持撤销 / 轮换 / `vendor_id` 权限范围；强制 TLS + 调用方级限流。**不视为高价值
  生产接口的唯一长期防线**；接入统一 IdP / 服务网格后演进为 JWT/OIDC 或 mTLS
  （[OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)）。
- **SSRF 完整策略** —— 默认禁止所有非公网地址（IPv4/IPv6）；vendor 显式
  `hostname + port + CIDR` 例外；DNS pinning（解析校验）；不跟重定向
  （[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)）。
  完整 CIDR 清单与算法进 ADR。

## Pending
- **Implementation-stage 授权**：尚未获得；不创建 Implementation-stage 服务代码、SQL migration 或运行制品（CP0 Pre-Implementation 骨架——go.mod、full-jitter 测试基线、CI——已由所有者授权，见 Module Status "MVP 代码" 行）
- **触发指标基线**（演进用）：实现后测量 outbox 深度增长、最老 pending 年龄和 vendor 饱和

## Active Risks
- 供应商是否 honor 幂等键不受我方控制 —— 出站重复为公开风险，由调用方对账兜底
- SSRF 实现复杂度：IPv4/IPv6 全覆盖 + DNS rebinding + 重定向绕过，须在 ADR 落实可验证清单
- API Key 为 MVP 防线 —— 长期须演进到更强认证（已在 Approved Architecture 标注）
- 阶段职责划分：模块图 / 模块 CDD / 逐模块评审 / 交叉评审属 Specification；run 03 已 PASS 并
  推进到 Architecture；主架构与 ADR 已独立 APPROVED；不提前运行 Pre-Implementation gate

## Module Status
| Module | Release status | Evidence status | Open risks |
|---|---|---|---|
| T0 宪法 | **v1.0 Accepted** | `basic_law_index.md`；审查 `../t3_archive/reviews/review-index.md`（附录）；amendment `../t3_archive/amendments/amendment-v1.0-2026-07-18.md` | — |
| `../../design/cdd/product-concept.md` | Reviewed（design-review APPROVED → Concept→Specification gate PASS, 2026-07-18） | `../../design/cdd/reviews/review-archive.md`；gate `../t3_archive/gate-archive.md` | — |
| Module map | **Approved**（6 模块 / 5 边 / DAG） | `../../design/cdd/module-index.md` | — |
| Notification Store CDD | **Approved**（fresh public-wire focused review #6；79 AC） | `../../design/cdd/notification-store.md`、`../../design/cdd/reviews/review-archive.md` | — |
| Vendor Registry CDD | **Approved**（fresh focused review #6；152 AC） | `../../design/cdd/vendor-registry.md`、`../../design/cdd/reviews/review-archive.md` | — |
| Caller Access CDD | **Approved**（fresh public-wire focused review #3；15 AC） | `../../design/cdd/caller-access.md`、`../../design/cdd/reviews/review-archive.md` | — |
| Delivery CDD | **Approved**（B-01 fresh focused review #4；20 AC） | `../../design/cdd/delivery.md`、`../../design/cdd/reviews/review-archive.md` | — |
| Operations Control CDD | **Approved**（limited-exception re-review #3；14 AC） | `../../design/cdd/operations-control.md`、`../../design/cdd/reviews/review-archive.md` | — |
| Reliability Observability CDD | **Approved**（limited-exception re-review #3；10 AC） | `../../design/cdd/reliability-observability.md`、`../../design/cdd/reviews/review-archive.md` | — |
| T1 supporting context | tech / system / behavior + `qa_context.md`（Observability + C1–C15 checklist）+ `system_patterns.md` 5 BL 锚点；Architecture 阶段已补 `architecture_context.md` / `ux_accessibility_context.md`（N/A stub）/ `knowledge_graph.md` / `module_support_map.yaml` | `../t1_axioms/` | —（4 文件已建；`module_support_map.evidence` 待实现） |
| Architecture / ADRs | **Approved**；stage = Architecture；四项 advisory 全部在 Architecture 范围闭合（#1 pepper 生命周期、#2 deadline backlog、#3 entities.yaml config_map 注册、#4 audit-trail SHA 基线） | `../../docs/architecture/`、`../../docs/api/openapi.yaml`、`../../docs/architecture/architecture-review-archive.md` | 实现未授权 |
| README / 设计文档 | 已建立 | `../../README.md`、`../../docs/design.md` | 已随 Architecture 包审查覆盖 |
| MVP 代码 | Pre-Impl 骨架已建（backoff leaf + 测试基线，authored-not-compiled，本地无 Go）；MVP 服务代码未开始 | `../../internal/delivery/backoff.go`、`../../internal/delivery/backoff_test.go`、`../../go.mod`、`../../.github/workflows/tests.yml` | MVP 服务代码仍待 Implementation 授权 |
| AI 使用说明 | 已建立（含 CP0 记录） | `../../docs/ai-usage.md` | 编码后须追加实现阶段记录 |

## Constitution Changelog
| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 (Draft) | 2026-07-18 | 所有者 + AI | 初版宪法：BL-01 + BL-02..BL-06 |
| 0.1 (Draft, rev 2) | 2026-07-18 | 所有者 + AI | 依草案审查与用户核验修订（幂等双边界分离、SSRF 边界、演进松绑、候选架构区分、审查证据归档、补 release_state） |
| 1.0 (Accepted) | 2026-07-18 | 所有者 | BL-02 增 `request_fingerprint` 冲突规则（409）与 `caller_id` 服务端推导；BL-05 SSRF 绑定 DNS pinning + 不跟重定向 + 全非公网禁（完整策略进 ADR）；release_state 删 CLI；PostgreSQL / API Key / SSRF 升为已批准架构决定（细节进 ADR / T1）；BL-01..BL-06 全部 Accepted。 |

## Amendment Sign-Off
本次 v1.0 签发于 2026-07-18 由项目所有者批准。变更已审查并接受：
- BL-01..BL-06：全部 Accepted
- 已批准架构决定（PostgreSQL / API Key / SSRF）：细节随后进 ADR / T1，不再膨胀 T0
- 详细证据：`../t3_archive/amendments/amendment-v1.0-2026-07-18.md`

## Phase Gate Log
| Date | Gate | Verdict | Evidence |
|---|---|---|---|
| 2026-07-18 | Concept → Specification (`/gate-check specification --review lean`) | PASS | `../t3_archive/gate-archive.md` Run 1 |
| 2026-07-20 | Specification → Architecture (`/gate-check architecture --review lean`) | **FAIL** | `../t3_archive/gate-archive.md` Run 2 |
| 2026-07-20 | Specification → Architecture run 02 (`/gate-check architecture --review lean`) | **FAIL** | `../t3_archive/gate-archive.md` Run 3 |
| 2026-07-20 | Specification → Architecture run 03 (`/gate-check architecture --review lean`) | **PASS** | `../t3_archive/gate-archive.md` Run 4 |

Architecture package review is not a stage gate. It was independently APPROVED on 2026-07-20; no
Architecture → Pre-Implementation gate was run.
