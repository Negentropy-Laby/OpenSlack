# Basic Law Index — T0 Core Constitution

> 本项目绑定的"现行根本法"。短小、可证伪的法律，用于裁决具体设计冲突。
> 设计理由（why）存放于 T1（`../t1_axioms/`）；本文件只承载法律本身（what）。
> 仅通过正式修订流程更改（amendment-only）。当前为 **v1.0 Accepted（2026-07-18）**。

## Core Thesis（核心论点 · BL-01）

一个"只投递、不处理"的内部服务：持久化接收内部业务系统提交的出站 HTTP 通知请求，
按 at-least-once 语义投递至**已配置并批准的**供应商端点，具备有界重试、可查询的死信状态
与人工重放。

- **可靠性姿态**：由 BL-02（投递语义与入站去重）、BL-03（持久化原子性）、BL-04（有界重试
  与死信）、BL-06（可观测性）协同构成。
- **系统边界与安全**：由 BL-05 独占裁定。
- **演进原则（binding）**：架构演进由**观测指标**触发，不提前承诺具体顺序或实现（如分片
  方式、是否多区域）；任何重大演进须先落 ADR 并通过 amendment 更新本宪法。具体候选演进
  路径与触发指标见 T1 / ADR（待建）。

---

## Foundational Current-State Laws（根本现行法律）

### Law 1 — 投递语义与入站去重
Support ID: BL-02 | Status: Accepted (2026-07-18)
- **Law:** 投递语义为 at-least-once。本服务对**入站**提供强去重：调用方提交的
  `Idempotency-Key`（配合**由服务端认证推导的** `caller_id`，不接受请求 Header/Body 自报）
  用于请求级去重。重复提交（相同键 + 相同 `request_fingerprint`）返回同一
  `notification_id`、不产生重复投递任务；相同键但指纹不同返回 `409 IdempotencyConflict`，
  不创建任务、不复用旧结果（防止错误复用 key 静默吞掉合法通知）。**出站**到供应商的重复
  是 at-least-once 的固有后果；只有当端点配置明确声明支持时，本服务才将幂等键映射到该
  端点指定的 Header/Body 字段；供应商不支持幂等时，重复副作用是已知公开风险，须在接入
  文档向调用方声明。永不承诺 exactly-once。
- **Current-state requirement:**
  - **入站**：存在 `(caller_id, Idempotency-Key)` 唯一约束；`caller_id` 取自服务端认证记录，
    不取自请求自报；持久化不可变 `request_fingerprint`；重复 POST（同键同指纹）返回同一
    `notification_id` 且不新增投递任务；同键异指纹返回 `409 IdempotencyConflict` 且不新增行
    （可证伪：两种二次提交各得到 idempotent / 409）。
  - **出站**：幂等键的 Header/Body 映射由**端点配置驱动**（配置项 `idempotency_header` /
    `idempotency_body_field`，缺省不写入）；不存在无条件向所有供应商 body 注入幂等键的
    代码路径。
  - README / 接入文档明文标注"at-least-once；入站去重为强保证；同键异指纹返回 409；出站
    重复为公开风险，除非端点配置幂等支持"。
  - 代码 / 文档 / 日志中不出现"exactly-once 投递"承诺。
- **Design test:**
  - 产品方要求"保证只送达一次"——本法律判定不可承诺；正解是 at-least-once + 入站强去重，
    并要求调用方对供应商副作用具备对账能力。
  - 调用方要求"所有供应商请求都带幂等键"——本法律禁止无条件注入；仅当端点配置声明支持
    时映射到该端点指定字段，以免破坏供应商既有 body 格式。
  - 调用方复用同一 `Idempotency-Key` 提交不同内容——本法律判定返回 `409 IdempotencyConflict`，
    不复用旧 `notification_id`、不创建新任务。
- **Supported by T1:** `../t1_axioms/system_patterns.md#delivery-semantics`（待建；指纹规范
  化算法、API Key 认证细节见 ADR）
- **Validated or executed through T2:** `../t2_execution/`（待建）

### Law 2 — 持久化原子性（禁止双写）
Support ID: BL-03 | Status: Accepted (2026-07-18)
- **Law:** 入站接收与入队投递在同一数据库事务内原子完成；outbox 表是唯一真相源。
  "先写库再写消息队列"的双写被禁止，除非该队列由 outbox relay 喂入。
- **Current-state requirement:** ingress 写 notification 行并在同一事务内返回 202；
  无任何代码路径在该事务外向独立队列 producer 写入；所有投递状态是该表的 status 列。
- **Design test:** 提案以 Kafka / RabbitMQ 作为工作队列——本法律禁止直接采用；除非经
  outbox relay 喂入，以保接收-到-投递的原子性。
- **Supported by T1:** `../t1_axioms/system_patterns.md#transactional-outbox`（待建；存储引擎
  PostgreSQL、行锁 `FOR UPDATE SKIP LOCKED` 见 ADR）
- **Validated or executed through T2:** `../t2_execution/`（待建）

### Law 3 — 有界重试与死信
Support ID: BL-04 | Status: Accepted (2026-07-18)
- **Law:** 重试必须有界（次数上限 + 墙钟上限）；超限后通知进入显式 `dead` 状态。
  dead 行即死信队列（DLQ），不引入独立死信基础设施。重放仅由人工触发。
- **Current-state requirement:** worker 最多尝试 25 次、墙钟上限 24h（常量 `MAX_ATTEMPTS` /
  `MAX_AGE`，见配置），full-jitter 指数退避；存在 `dead` 状态；无任何代码路径自动从
  `dead` 回到 `pending`；存在人工重放原语（单条 + 批量 + dry-run）。
- **Design test（两场景）:**
  - **瞬态失败**（vendor 5xx / 超时 / 429）：按退避重试，直至命中上限。
  - **长期不可用**（vendor 端点连续数日不可达）：命中墙钟上限后转 `dead`，系统不自动恢复；
    待人工确认连通后重放。
- **Supported by T1:** `../t1_axioms/system_patterns.md#retry-and-dlq`（待建）
- **Validated or executed through T2:** `../t2_execution/`（待建）

### Law 4 — 边界与安全：管道而非处理器，且仅向已批准端点投递
Support ID: BL-05 | Status: Accepted (2026-07-18)
- **Law:** 本系统是投递管道，且仅向**已配置并批准的目标端点**投递。出站代码不读供应商
  响应体的业务字段；ingress 不对入站 payload 做深度校验；出站目标地址不得由调用方任意
  指定。
- **Current-state requirement:**
  - **管道限制**：出站投递代码仅读取 HTTP status 与 retry-relevant header（如
    `Retry-After`），不解析响应体业务字段；ingress 仅校验闭合的 JSON 结构字段清单（见配置
    `SCHEMA_FIELDS`），畸形 JSON 拒绝、其余接受。
  - **目标地址限制（防 SSRF）**：出站 URL 仅取自 `vendor_endpoints` 配置表（已批准端点）；
    调用方通知仅能引用 `vendor_id`，不得直接指定 URL；可信调用方认证（`caller_id` 服务端
    推导）；默认强制 HTTPS；**默认禁止所有非公网地址**（IPv4/IPv6 私网、回环、链路本地、
    组播、保留、ULA 及非全局地址），企业内网供应商按 vendor 显式批准 `hostname + port + CIDR`
    例外；**连接前校验 A/AAAA 解析结果**（DNS pinning，防 DNS rebinding）；**默认不跟随
    HTTP 重定向**。完整 CIDR 清单、解析校验算法与重定向策略见 ADR / T1。
  - README "明确不做"章节列明 non-goal 清单：exactly-once、响应驱动分支、跨通知排序保证、
    多区域部署、深度 payload 校验、**任意目标地址代理**。
- **Design test:**
  - 需求要求"按供应商返回值分支处理"——本法律判定其越界；那是工作流引擎，属于另一个产品。
  - 调用方请求"向自定义 URL 投递"或提交内网 / 回环 / 元数据地址，或供应商端点经 DNS 解析
    到非公网——本法律判定其被拒；本服务不是开放代理，仅投递已批准端点。
- **Supported by T1:** `../t1_axioms/system_patterns.md#scope-boundary`、
  `../t1_axioms/system_patterns.md#ssrf-prevention`（待建；完整 SSRF 策略见 ADR）
- **Validated or executed through T2:** `../t2_execution/`（待建）

### Law 5 — 可观测性即可靠性前提
Support ID: BL-06 | Status: Accepted (2026-07-18)
- **Law:** 任何"可靠"声明必须由指标支撑。outbox 深度、最老 pending 年龄、dead 计数三项
  指标自 day-1 暴露；并存在一条针对 dead-count 的告警规则定义。
- **Current-state requirement:** 三项指标在代码中暴露；配置中存在 dead-count 告警规则定义；
  任何文档不得在缺少这三项指标时声称"可靠"。
- **Design test:** AI 建议"先上线、后补监控"——本法律拒绝该顺序；不可观测的"可靠"不可证伪。
- **Supported by T1:** `../t1_axioms/qa_context.md#observability`（待建）
- **Validated or executed through T2:** `../t2_execution/`（待建）
