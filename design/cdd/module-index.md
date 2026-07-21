# Module Index: rc_wsman — API 通知投递服务

> **Status**: Approved
> **Created**: 2026-07-18
> **Last Updated**: 2026-07-20
> **Source Concept**: `design/cdd/product-concept.md`
> **Method**: `/map-systems --review lean`（手动执行；rc_wsman 未安装 CDD）+ 可选 TD-SYSTEM-BOUNDARY 边界审查（CONCERNS 已处置）

## Overview

本索引把已批准的产品概念（`design/cdd/product-concept.md`，Concept → Specification gate PASS）
拆分为 **6 个设计模块**，支撑：

- **Core Promise**：提交即忘、可靠送达——at-least-once + 有界重试 + 可查询 + 可人工重放；
- **调用方 JTBD**：把通知丢给可靠中转，专注业务逻辑，不必自处理传输差异 / 重试 / 幂等 / 失败重放；
- **宪法 BL-01..BL-06** 的绑定约束。

模块边界按**独立状态 / 契约 / 信任边界 / 失败生命周期**划分，**不按代码包**。`Approved` 仅表示
规格契约已批准，不表示源码或测试存在。六份 CDD 均已起草并通过独立复审；Delivery 的 24h
deadline B-01 已由所有者裁决为“当前 actual-result 写回原子终止”，Store 联合、公开 wire 与 Vendor
method 来源也已分别通过 fresh focused review。栈机制与算法由 Architecture/ADR 文档承接。

## Module Enumeration

| # | Module | Category | Priority | Status | Design Doc | Depends On | Source |
|---|---|---|---|---|---|---|---|
| 1 | Notification Store | Foundation | MVP Workflow | Approved | `notification-store.md` | — | explicit（intake + outbox 合并） |
| 2 | Vendor Registry | Foundation | MVP Workflow | Approved | `vendor-registry.md` | — | explicit |
| 3 | Caller Access (inferred) | Core | MVP Workflow | Approved | `caller-access.md` | — | inferred |
| 4 | Delivery | Feature | MVP Workflow | Approved | `delivery.md` | Vendor Registry, Notification Store | explicit（outbound + orchestration 合并） |
| 5 | Operations Control | Operations | MVP Workflow | Approved | `operations-control.md` | Notification Store, Caller Access | explicit |
| 6 | Reliability Observability | Operations | MVP Workflow | Approved | `reliability-observability.md` | Notification Store | explicit |

**责任假设（one-sentence each）：**
- **Notification Store** — 拥有通知持久化、原子接收、不可变请求身份、投递状态机、尝试历史与并发可见的存储契约（BL-02 指纹 + BL-03 原子）。
- **Vendor Registry** — 拥有已批准供应商端点记录、静态凭证引用、传输 / 认证 Header 策略、端点驱动的幂等键映射，**以及供应商存在性 / 禁用的单一权威判定**（BL-05）。
- **Caller Access (inferred)** — 验证 API Key、服务端推导 `caller_id`、**校验 key→`vendor_id` 授权范围（自包含；供应商存在性由 Vendor Registry 判定、由 intake/delivery 校验，非本模块设计依赖）**、定义调用方限流并保护操作员动作（BL-02 / BL-05）。
- **Delivery** — 解析已批准端点、强制 SSRF 行为 / 不跟重定向 / 超时、**协调"下一步认领目标"（认领原语 `SKIP LOCKED` 与租约行归 Notification Store）**、调度 full-jitter 重试、执行 25 次 / 24h 上限、转换 delivered/dead，执行单次 HTTP 尝试且不解析业务响应（BL-03 / BL-04 / BL-05）。
- **Operations Control** — 提供通知 / dead 状态查询与受守护的人工重放（单条 / 批量 / dry-run）（BL-04）。
- **Reliability Observability** — 定义 outbox 深度、最老 pending 年龄、dead 计数三项指标、告警语义与操作员可靠性信号（BL-06）。（MVP 三指标仅消费 Notification Store；per-vendor 错误率为 v1+ 演进，届时再引入 Delivery 依赖。）

## Categories

| Category | Meaning |
|---|---|
| Foundation | 持久化状态 / 参考数据 / 原子性边界——零设计依赖 |
| Core | 信任 / 认证 / 授权边界 |
| Feature | 业务工作流（投递生命周期、接收契约） |
| Operations | 操作员面（查询、重放、可观测信号） |

无 Presentation / 游戏 UI 类别——内部 headless 服务。

## Priority Tiers

| Tier | Modules |
|---|---|
| **MVP Workflow** | 全部 6 个（端到端"提交 → 持久化 → 尝试 → 终态 / 操作员恢复"承诺必需） |
| Integration Milestone | _empty_（v1 LISTEN/NOTIFY、多 worker 为 Delivery 演进） |
| Operational Readiness | _empty_（retention 为 Notification Store 演进；SLO 仪表盘为 Reliability Observability 演进） |
| Full Vision | _empty_（按 vendor 分片 / 限流为 Delivery 演进；多区域需 amendment） |

层可为空；不为填充层级而造模块。BL-05 安全与 BL-06 day-1 可观测性不被降级。

## Dependency Map（拓扑分层）

- **Layer 0（叶子，零设计依赖）**
  - Notification Store — depends on: —
  - Vendor Registry — depends on: —
  - Caller Access (inferred) — depends on: —
- **Layer 1**
  - Delivery — depends on: Vendor Registry, Notification Store
  - Operations Control — depends on: Notification Store, Caller Access
  - Reliability Observability — depends on: Notification Store
- **Layer 2**
  - _empty_

**反向依赖计数**：Notification Store = 3（瓶颈，状态核心）；Vendor Registry = 1；Caller Access = 1；Delivery = 0；Operations Control = 0；Reliability Observability = 0。

**安全方向（已验证）**：调用方不能绕过 Caller Access（`caller_id` 为已验证输入）；Delivery 不能绕过已批准供应商策略（→ Vendor Registry）；重放不能绕过状态与授权（Operations Control → Notification Store + Caller Access）。

## Recommended Design Order

| Order | Module | Priority | Layer | Reviewer roles | Est. Effort |
|---|---|---|---|---|---|
| 1 | Notification Store | MVP Workflow | 0 | backend / data | M |
| 2 | Vendor Registry | MVP Workflow | 0 | backend / security | S |
| 3 | Caller Access | MVP Workflow | 0 | security | S–M |
| 4 | Delivery | MVP Workflow | 1 | backend + security (SSRF) | L |
| 5 | Operations Control | MVP Workflow | 1 | backend | S–M |
| 6 | Reliability Observability | MVP Workflow | 1 | backend / SRE | S |

设计顺序遵循依赖（被依赖最多的瓶颈先做）；Est. Effort = **设计会话**（S=1, M=2–3, L=4+），非实现工作量。技术基线已在
`../../standards/technical-preferences.md` 固定为 Go/PostgreSQL 单体服务；本表仍只列角色级评审，
不把技术选型误写成实现已经开始。

## Circular Dependencies

**无。** 已做拓扑与环检测：6 节点、5 条依赖边、DAG；最长链 L0 → L1，无回边。

## High-Risk Modules

| Module | Risk Type | Risk Description | Mitigation |
|---|---|---|---|
| Notification Store | Correctness | 入站去重 / `request_fingerprint` 冲突（409）/ 事务原子性 / 并发（`SKIP LOCKED`） | BL-02 指纹冲突 + BL-03 单事务原子；CDD 定义状态机与可测试验收条件 |
| Delivery | Security | SSRF / DNS rebinding / 重定向绕过 / IPv4-IPv6 全覆盖 | BL-05 行为契约（拒非公网 + DNS pinning + 不跟重定向）；具体算法在 SSRF ADR |
| Delivery | Reliability | 有界重试 / dead 转换 / 重放安全 | BL-04（25/24h + dead + 人工重放）；CDD 定义失败生命周期 |
| Caller Access | Security | API Key 为 MVP 唯一防线 / `caller_id` 服务端推导 / `vendor_id` 授权 | BL-02 推导；演进 JWT/OIDC/mTLS（Architecture） |
| Operations Control | Safety | 人工重放误操作 / 状态翻转竞态 | BL-04 重放需授权 + dry-run；依赖 Caller Access 操作员授权 |

## Boundary Review Notes（TD-SYSTEM-BOUNDARY, 2026-07-18）

> 可选独立 Technical Director 边界审查（`/map-systems` 后、CDD 撰写前；非 Lean 自动门禁的补审）。
> 结论：**CONCERNS**（非阻塞；6 模块结构成立，CDD 撰写可进行；无 REJECT，未静默 APPROVE）。

**已应用的索引澄清（3）：**
- **#4** Delivery 责任：明确"协调下一步认领目标；认领原语 `SKIP LOCKED` 与租约行归 Notification Store"。
- **#6** 供应商存在性 / 禁用：单一权威归 Vendor Registry；Caller Access 仅校验 key→`vendor_id` 授权范围（自包含，无设计依赖）。
- **#10** 去掉 Reliability Observability → Delivery 边（MVP 三指标均 Store 派生；per-vendor 错误率为 v1+ 演进）。

**携入对应 CDD 的边界笔记（8；撰写相应 CDD 时落实，CDD 评审前核验）：**
- `notification-store.md`：transition-request 协议（签名 + Store 拒绝语义）；attempt-history 写入归属（暴露 `append_attempt`）；stale-in-flight reaper 归属（状态机恢复）；`caller_id` 在契约边界为不透明已验证串；Internal Structure 节点明子职责（IntakeValidator / OutboxRepository / TransitionGuard / AttemptLog）。
- `delivery.md`：消费 Store 的 transition 原语；**显式**采用每个未开始 attempt 读取
  `latest_active`（不按 delivery cycle 固定配置版本）；划分无持久状态的 attempt orchestration，
  Store 仍是唯一调度/状态真相源。
- `operations-control.md`：重放时 `attempt_count` 重置语义（推荐重置 + `replay_count` 保留审计）。
- `vendor-registry.md`：声明供应商存在性 / 禁用为单一权威。
- `caller-access.md`：`caller_id` 为已验证输入；消费 vendor 事实（不拥有）。
- `reliability-observability.md`：注明 MVP 指标仅消费 Notification Store。

## Cross-cutting Concerns Not Modeled as Modules

（行为要求落在所属模块 CDD；栈相关实现延后到 Architecture）

- 应用配置与密钥加载（`vendor_endpoints`、`caller_keys` 哈希、`SCHEMA_FIELDS`、`MAX_ATTEMPTS`/`MAX_AGE`、`BLOCKED_CIDRS`、幂等键字段映射）
- 结构化日志与共享错误格式
- 通用 PostgreSQL 连接 / 连接池 + 迁移工具
- HTTP 客户端库选择（出站硬超时、no-redirect、DNS pinning hook）
- API 框架 / OpenAPI 生成
- 部署打包

## Progress Tracker

| 指标 | 值 |
|---|---|
| 已识别模块总数 | 6 |
| 已起草 CDD | 6 / 6 |
| 已评审 CDD | 6 / 6 |
| 已批准 CDD | 6 / 6 |
| MVP Workflow 模块已设计 | 6 / 6 |
| Integration Milestone 模块已设计 | 0 / 0 |

## Next Steps

1. Run 03 consistency-check 与 fresh cross-review 已 PASS；290 canonical AC + 4 boundary mapping
   已精确覆盖，Specification → Architecture gate 已 PASS。
2. Architecture 包独立审查已 APPROVED，证据见
   `../../docs/architecture/architecture-review-archive.md`。
3. 停在 Architecture，等待新的实现授权；不运行 Architecture → Pre-Implementation gate，
   不创建源码、测试、迁移或 CI。
