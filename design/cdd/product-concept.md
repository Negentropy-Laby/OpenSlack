# Product Concept: API 通知投递服务（Notification Delivery Service）

<!-- Formalizes the take-home assignment into a CDD product concept.
     Authored 2026-07-18. Status: Reviewed (design-review APPROVED 2026-07-18). -->

> **模板裁剪说明**：本项目是内部基础设施服务，无终端用户界面。`templates/product-concept.md`
> 中面向终端用户的 section（Visual Identity、User Journey 的"关系"层、Self-Determination
> Theory）不适用，已裁剪或将"User Journey"改编为"Notification Lifecycle（通知生命周期）"。
> Principles 直接复用已签发的 T0 宪法 v1.0（BL-01..BL-06），保证概念与法律层一致。

## Core Identity

| Field | Value |
|-------|-------|
| **Working Title** | `rc_wsman` — API 通知投递服务 |
| **Elevator Pitch** | 内部业务系统在关键事件发生时调用本服务，由本服务可靠地把通知投递到外部供应商的 HTTP(S) API——业务系统"提交即忘"，不关心返回值。 |
| **Core Action** | 业务系统提交一条通知请求；本服务持久化并按配置投递到对应供应商端点 |
| **Core Promise** | 提交即忘，可靠送达：at-least-once 投递、有界重试、可查询、可人工重放 |
| **Unique Hook** | 像 webhook outbox，但**只做投递管道**——不解析、不转换、不依据响应做业务分支 |
| **Primary User Need** | 业务系统需要把"事件已发生"可靠告知外部系统，且不想自己处理重试 / 幂等 / 失败追踪 |
| **Estimated Scope** | Small-Medium（MVP：单服务 + PostgreSQL，1 人数周） |

## Discovery Brief（作业背景与问题）

企业内部多个业务系统在关键事件发生时，需调用外部供应商 HTTP(S) API 通知（例：广告引流
注册成功 → 通知广告系统；订阅付款成功 → 通知 CRM；购买 → 通知库存）。各供应商的端点、
认证方式与业务 payload 格式各异；业务系统**不关心返回值**，只需确保通知可靠送达。调用方按
目标供应商格式自行构造业务 payload；本服务收拢"可靠投递"职责——从**传输差异**（受控端点
解析、静态凭证、传输 / 认证 Header、重试 / 幂等 / 死信策略）中解耦业务系统，但**不**承担业务
字段映射、模板渲染或 schema 转换（见 BL-05 裁决）。

## Target Users

### Primary User — 调用方（内部业务系统）
内部业务系统（广告归因、订阅计费、订单 / 库存等后端）及其开发 / 维护者。

**Job they're hiring for (JTBD):**
"当关键事件发生时，我想把通知（含我已按供应商格式构造的 payload）丢给一个可靠的中转，
这样我可以专注业务逻辑，而不必自己处理传输差异、重试、幂等与失败重放。"

### Secondary User — 运维 / 操作员
负责监控投递健康、处理死信、在供应商恢复后执行重放、审批与配置新供应商端点。

**JTBD:** "当投递出问题或供应商长期不可用时，我想第一时间看到、并能安全地重放，而不需要
写脚本或猜状态。"

### External Party — 接收方（外部供应商 HTTP API）
非"用户"，但需在接入文档约束：若供应商支持幂等键去重，重复投递的副作用可被消除；否则
重复副作用是**公开风险**（见宪法 BL-02）。

### Who This Is NOT For
- 需要供应商返回值驱动业务分支的流程（那是工作流引擎，不是本服务）
- 需要跨通知顺序保证的上游
- 公网不可信调用方（本服务仅服务已认证的内部业务系统）

## Notification Lifecycle
> *改编自模板的 User Journey——记录通知（而非终端用户）从提交到终结的状态流，
> 对应宪法 BL-02..BL-04。*

1. **接收（秒）**：业务系统提交 → 同事务持久化 + 入站去重（同键同指纹 idempotent；同键异
   指纹 `409`）→ 返回 `202` + `notification_id`
2. **投递（秒~分钟）**：worker 取 `pending` → 向**已批准**供应商端点投递（HTTPS、SSRF 防护、
   硬超时、端点配置驱动的幂等键映射）
3. **瞬态失败**：`5xx` / 超时 / `429` → full-jitter 退避重试（≤ 25 次 / ≤ 24h）
4. **长期不可用**：命中上限 → `dead` 状态（dead 行即 DLQ）+ 告警
5. **人工重放**：操作员确认供应商恢复 → `dead` → `pending`（单条 / 批量 / dry-run）
6. **终态**：`delivered` 或 `dead`（可查询 `last_error`、`attempt_count`）

## Principles（与 T0 宪法 v1.0 BL-01..BL-06 一致）

### Product Principles

| # | Principle | 来源 | 设计裁决摘要 |
|---|-----------|------|--------------|
| 1 | 投递语义 = at-least-once；入站强去重 | BL-02 | 拒绝 exactly-once；同键异指纹返回 `409` |
| 2 | 持久化原子性（禁止双写） | BL-03 | outbox 单一真相源；拒绝裸 Kafka 作工作队列 |
| 3 | 有界重试 + dead 即 DLQ + 人工重放 | BL-04 | 拒绝"自动重放自愈" |
| 4 | 边界：管道非处理器 + 仅向已批准端点投递（防 SSRF）；调用方负责业务 payload，服务负责认证 / 受控端点 / 静态 Header / 可靠投递 | BL-05 | 拒绝响应驱动分支；拒绝业务字段映射 / 模板转换；拒绝开放代理与调用方自定 URL |
| 5 | 可观测性即可靠性前提 | BL-06 | 拒绝"先上线后补监控" |
| 6 | 演进由观测指标触发 | BL-01 | 不提前锁定分片 / 多区域顺序 |

### Anti-Principles

| # | 不做什么 | 因为违反 |
|---|----------|----------|
| 1 | 不承诺 exactly-once | BL-02（外部 HTTP 不可控） |
| 2 | 不解析 / 转换 / 业务字段映射 / 模板渲染 / schema 转换 / 依据供应商响应做业务分支 | BL-05（业务 payload 由调用方负责；响应分支是工作流引擎） |
| 3 | 不向调用方自定 URL 投递，不做开放代理 | BL-05（SSRF） |
| 4 | 不自动从死信恢复 | BL-04（需人工裁决） |
| 5 | 不在 day-1 引入 Kafka / 多区域 / 微服务拆分 | BL-01 / BL-03（演进由指标触发） |

> **BL-05 裁决（responsibility split）**：调用方负责生成最终业务 payload，并提交 `vendor_id`、
> 业务 payload 和入站幂等键；服务负责调用方认证、`vendor_id` 授权、从受控配置解析已批准端点
> 及静态认证信息、按端点配置写入必要的传输 / 认证 Header，以及可靠投递。服务不提供业务字段
> 映射、模板渲染或供应商 schema 转换。"供应商差异"仅指受控端点解析、静态凭证、传输 / 认证
> Header 与投递策略；业务 payload 的形状与语义始终由调用方负责。

## Visual Identity

**N/A** —— 内部基础设施服务，无终端用户 UI。若未来引入管理 / 重放界面，再单独设计。

## 业界参照（Market Validation 改编）

- **类似系统**：Stripe webhook delivery、Svix、Hookdeck、AWS EventBridge——均为 webhook / outbox 模式
- **共性教训**：transactional outbox + at-least-once + 幂等键 + 可观测 DLQ 是行业共识
- **本服务的取舍差异**：明确只做投递管道（不做事件路由 / 转换 / 编排），换取更小的复杂度与运维面

## Scope

### Target Platform
服务端（内部部署；单 region 多 AZ）

### Tech Stack
PostgreSQL（已批准架构决定）；语言 / 框架 / 驱动版本待 `/setup-engine`。

### Feature Scope (MVP)
- HTTP 提交通知入口（API Key 认证；入站去重；`request_fingerprint` 冲突 `409`）
- transactional outbox（同事务持久化 + `202`）
- worker（`FOR UPDATE SKIP LOCKED` + full-jitter 退避 + 有界重试 + `dead` 状态）
- per-vendor 受控端点配置（URL 与静态认证 / 传输 Header 来自服务端配置；业务 Body 由调用方
  按供应商格式构造、本服务原样透传不改写；不接受调用方自定 URL；**端点配置驱动**的幂等键映射）
- SSRF 防护（仅已批准端点 + DNS pinning + 不跟重定向 + 全非公网禁）
- 死信查询 + 人工重放（单条 / 批量 / dry-run）
- 状态查询（`pending` / `in_flight` / `delivered` / `dead` + `last_error` + `attempt_count`）
- 三项指标（outbox 深度 / 最老 pending 年龄 / dead 计数）+ dead-count 告警规则

### Feature Scope (Full Vision)
v1 之上：`LISTEN/NOTIFY` 降延迟、多 worker 副本、vendor 公平性 / 限流、按 vendor 分片、
保留 / 归档、per-vendor SLO 看板——**均由观测指标触发**（BL-01 演进原则）。

### Scope Tiers

> 下表为候选演进路径，仅在对应指标触发时推进；tier 标签为分组而非顺序承诺（见 BL-01）。

| Tier | 内容 | 触发条件 |
|------|------|----------|
| **MVP** | 上述 MVP 范围 | 现在 |
| **v1** | `LISTEN/NOTIFY` + 多 worker + vendor paused（轻量暂停原语，不引入 circuit-breaker 库） | 延迟 / 吞吐成为指标瓶颈 |
| **v2+** | 按 vendor 分片、限流、优先级、保留归档 | 单 vendor 饱和或表膨胀 |

## 作业必答问题（概念层立场）

> 详细论证见后续 README / 设计文档；此处先钉概念层立场，确保与宪法一致。

1. **系统边界** — 解决"可靠投递"（持久化、重试、死信、重放、可观测、SSRF 安全）；**不解决**
   exactly-once、响应驱动分支、跨通知排序、多区域、深度 payload 校验、业务字段映射 / 模板 /
   schema 转换、调用方自定目标 URL、开放代理。依据：业务系统"提交即忘"、供应商 API 异构且
   不可控——把复杂度收敛到"投递管道"是最高杠杆。
2. **可靠性与失败** — at-least-once（exactly-once 在异构外部 HTTP 上不可能；at-most-once 对
   付款 / 库存不可接受）；长期不可用 = 有界重试（25 次 / 24h）后转 `dead` + 告警 + 人工重放。
3. **取舍与演进** — 拒绝的过度设计：Kafka day-1、exactly-once、自动重放、工作流引擎、多区域、
   微服务拆分、circuit-breaker 库、先上线后监控。演进由观测指标触发，具体路径与顺序经 ADR +
   amendment 决定，不提前锁定（见 BL-01）。

## Risks

| Category | Risk | Severity | Mitigation |
|----------|------|----------|------------|
| Technical | 供应商不 honor 幂等键 → 重复副作用 | Med | 调用方对账；per-endpoint 记录；接入文档声明 |
| Technical | SSRF 绕过（DNS rebinding / 重定向 / IPv6） | High | 全非公网禁 + DNS pinning + 不跟重定向；ADR 落可验证清单 |
| Technical | API Key 作为 MVP 唯一防线 | Med | 限流 + 哈希 + 轮换；演进 JWT/OIDC/mTLS |
| Design | 错误复用幂等键吞掉合法通知 | Med | `request_fingerprint` 冲突 `409`（BL-02） |
| Adoption | 业务系统误用为同步 RPC（等返回值） | Low | `202` 契约 + 文档；状态查询而非同步返回 |

## Next Steps（按 CDD 正确顺序）

1. ✅ `/design-review design/cdd/product-concept.md` — 已完成（独立复审 APPROVED 2026-07-18）
2. `/gate-check concept` — 概念阶段门禁（下一步）
3. `/map-systems` — 拆分为模块（ingress / outbox / worker / vendor-config / replay /
   observability）+ 依赖关系
4. `/design-system [module]` — 各模块详细 CDD（8 必需 section）
5. `/setup-engine` — 确定语言 / 框架 / 驱动版本（PostgreSQL 已定，不重选数据库）
6. `/architecture-decision` — 撰写四份 ADR（PostgreSQL outbox+并发 / API Key 认证 / SSRF 安全
   投递 / 幂等指纹）；**须在 `/setup-engine` 后**做 Stack Compatibility 验证
7. `/create-architecture` — 主架构蓝图
8. `/gate-check` — 实现前就绪门禁

---

**Created:** 2026-07-18
**Last updated:** 2026-07-18
**Status:** Reviewed（design-review 独立复审 APPROVED, 2026-07-18）
**Governed by:** T0 宪法 v1.0（`memory_bank/t0_core/basic_law_index.md`）
