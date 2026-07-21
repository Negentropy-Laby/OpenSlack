# QA Context

> T1 supporting context。质量、评审与证据纪律。支持 T0 BL-06（`#observability`）。
> stack-neutral：只定义行为与证据纪律，不写 SQL、框架 API、具体测试库或 CI 平台。
> 模块适用性清单（C1–C15）权威落点；后续每模块 CDD 成稿前逐条核验 `Applied` / `N/A — reason`。

## Observability

BL-06 三项 day-1 可靠性信号（自 day-1 暴露，不"先上线后补监控"）：

- **outbox 深度**：`state=pending` 的 notification 计数（积压信号）。
- **最老 pending 年龄**：`now − min(created_at) where state=pending`（滞留/饥饿信号）。
- **dead 计数**：`state=dead` 的 notification 计数（长期不可用信号）。

- 存在一条可执行的 **dead-count 告警规则**：`dead_notifications > 0` 持续 `5m`；
  threshold / duration 是 MVP 固定契约且不允许运行时覆盖。只有通知渠道与路由由部署配置；
  规则定义 day-1 必须存在。
- **反伪证**：缺这三项指标 + dead-count 告警时，任何文档/声明不得称系统"可靠"（BL-06 design test）。
- 物理机制（计数器/汇总表/导出格式）= Architecture / ADR deferred；逻辑模型须**不排除**维护型汇总。

## Design Review Discipline

- **`/design-system` 只产出 `Designed — pending independent design-review`**；不授 `Approved`。
- **`/design-review` 须在新会话独立运行**（独立 agent，不继承作者上下文）；verdict `APPROVED` / `NEEDS REVISION`。
- **`NEEDS REVISION`**：bounded correction（只修评审指出的项）→ 新会话独立复审；循环直到无 blocker。
  不得同会话自批；不得静默把 NEEDS REVISION 改记为 APPROVED。
- **Lean 模式**：只跳过**适用的非阶段 director gate**（如 `CD-GDD-ALIGN`）；**不**跳过必要的技术
  （lead-programmer）、安全（security-engineer）、部署（devops-engineer）或 QA（qa-lead）章节审查。
- **配置归属纪律**：模块 CDD 只声明本模块拥有/校验的配置；下游策略（Delivery 的 `MAX_ATTEMPTS`/
  `MAX_AGE`/full-jitter、Vendor Registry 的出站幂等键映射）不得被本模块窃取为自有。
- **不重写历史评审**：boundary-review 历史文字（含编号）不在模块作者流程中改写；用局部 `NS-BR`/`VR-BR`
  追踪，全局统一编号须另作文档修正。

## Acceptance Criteria Evidence Types

独立 AC 全部 **Given–When–Then**，指明可观察证据类型（不写测试框架/断言库）：

| 类型 | 适用 |
|---|---|
| Logic | 公式、状态机、不变量、判定矩阵 |
| API Contract | HTTP/操作的请求-响应-错误形状（含负向） |
| Integration | 跨操作/跨模块生命周期、端到端路径 |
| Concurrency | 竞态、OCC、lease/claim、并发同键 |
| Migration | schema 演进、append-only/不可变字段在迁移下的保全 |
| Security Negative | 越权/伪造/泄露/存在性探测的负向断言 |

- 每条 AC 可证伪（具体值/状态/计数）；跨模块 AC 标 `provisional until dependent CDD approval`。
- 覆盖：每条 core rule、每个逻辑实体/关键不变量、每个 boundary obligation（`NS-BR`/`VR-BR`）≥1 条。

## Test Boundaries

- **Contract**：操作契约的输入-输出-错误-幂等形状（含判别联合各变体）。
- **Integration**：intake→…→terminal 全生命周期；恢复 sweeper；指标查询。
- **Concurrency**：双重 claim、stale version、过期 lease vs 成功上报、重复 replay、并发同键。
- **Migration**：schema 演进下 append-only 历史 + 不可变字段不被破坏（具体在 Architecture/migration tooling 定后）。
- **Security Negative**：自报 caller_id、actor kind/scope/capability、URL 或未知 envelope 字段被拒绝；
  跨 scope→not-found；伪造 lease/actor→invalid-lease；Store/Delivery 不持久化供应商响应体，
  因此不存在 `raw_response_ref` 必填不变量。
- 测试框架/CI/桩选择 = Architecture / ADR deferred；CDD 只规定可观察行为 + 证据类型。

## Module-Design Applicability Checklist

> 从 Notification Store 4 轮独立评审（15 blocker）提炼。每模块 CDD 成稿前**逐条**标记
> `Applied`（+ 正文落点）或 `N/A — reason`。不得把 Notification Store 的具体实现规则误升格为普遍法律。
> 证据指针指向 `../../design/cdd/reviews/review-archive.md` §Notification Store（2026-07-21 合并归档；不在此复制全文）。

| ID | 通用栏杆 | NS 溯源 |
|---|---|---|
| C1 | 操作契约闭合：actor/context、输入、结果、错误、副作用齐全；多变体时定义判别联合或合法组合矩阵，否则 N/A | 初审 #1 |
| C2 | 写入/审计边界明确：逐类说明成功/拒绝/失败产生领域审计、持久安全审计或仅运行事件；不得意外修改无关历史 | 初审 #2 |
| C3 | 字段不跨边界消失：每个被校验/计算字段有持久化/返回/下游消费/主动丢弃裁决 | 初审 #3 |
| C4 | Worked Example 与规则自洽：计数/版本/序列/阈值/状态转换可复算 | 初审 #4 |
| C5 | 存在调度/资格/门控的操作：完整列出 state/time/scope/capability 条件；否则 N/A | 复审#1 #1 |
| C6 | 按威胁模型防未授权者获存在性/状态/版本；错误形状稳定去敏（不强制统一固定 payload） | 复审#1 #2 |
| C7 | 并发写/竞争操作：定义唯一可测试败方结果；纯只读模块 N/A | 复审#1 #3 |
| C8 | 仅对可能提交结果未知/远端结果未知的操作：区分 confirmed rollback vs outcome unknown + 收敛路径 | 复审#1 #4 |
| C9 | Actor 模型完备：所有可能出现在命令/审计/运行事件中的 actor kind 一等 | 复审#1 #5 |
| C10 | 安全/调度相关时间用服务端权威时钟；无时间门控的操作 N/A | 复审#2 #1 |
| C11 | 受保护操作：actor kind × scope × capability 矩阵，非仅 ownership | 复审#2 #2 |
| C12 | 可能无界的 collection/list/history：有界游标分页 + page cap；singleton/固定聚合不强制分页 | 复审#2 #3 |
| C13 | 正文引用字段有模型归宿；可变实体定义 set/clear/immutable 规则 | 复审#2 #4 |
| C14 | 读模型遵循 scope；scoped vs global 查询/聚合分离，global 显式授权 | 复审#3 #1 |
| C15 | collection 操作：default/max page size + 稳定排序键 + scope filter + snapshot/live 漂移语义；非集合 N/A | 复审#3 #2 |

**成稿前自检**：逐条核验 Applied / N/A（带理由）；漏项补齐再标 Designed。NS 自检缺此步骤致 4 轮复审。
