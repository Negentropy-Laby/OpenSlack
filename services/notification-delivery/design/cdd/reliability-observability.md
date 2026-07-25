# Reliability Observability

> **Status**: Approved — T1 alert ownership independently re-reviewed 2026-07-20
> **Module**: Reliability Observability（Operations · Layer 1）
> **Source**: `product-concept.md`、`module-index.md`、T0 BL-06
> **Scope budget**: ≤250 lines / ≤15 acceptance criteria
> **Last Updated**: 2026-07-20

## Overview

Reliability Observability 将 Notification Store 的权威全局聚合投影为三项 day-1 可靠性指标，并定义
dead-count 告警语义。它只读、不缓存业务真相、不执行重放或自动修复，也不依赖 Delivery 或 Vendor
Registry。

## User Promise

从 day-1 起，操作员可通过 outbox 深度、最老 `pending` 年龄、`dead` 计数及 dead-count 告警，
判断投递积压与失败是否需要处置。该模块提供可靠性声明所需的可证伪信号，不承诺监控本身完成投递
或自动修复。

## Detailed Design

### Core Specification

1. 每次采集只调用一次 Store global `query_outbox`，ActorContext 必须为
   `kind=system + read_all_notifications`。
2. 输出恰好三项 MVP gauge：

| Metric | Type / unit | Authoritative value |
|---|---|---|
| `rc_wsman_outbox_pending` | gauge / count | `pending_count` |
| `rc_wsman_oldest_pending_age_seconds` | gauge / seconds | Store 计算的 oldest pending age；无 pending 为 `0` |
| `rc_wsman_dead_notifications` | gauge / count | `dead_count` |

3. 指标不带 `vendor_id`、`notification_id`、`caller_id`、payload、错误文本或 credential 等标签/内容。
4. Store 查询失败、超时或鉴权拒绝时，本次采集失败：不发布三个虚假零值，也不把旧样本重新标记为新样本。
5. dead 告警固定为 `rc_wsman_dead_notifications > 0` 持续 5 分钟后 firing；只有后续成功采集到
   `0` 才 resolved。进入 firing 前，任一采集失败使 pending timer 进入 unknown 并清零，下一次
   成功的 `>0` 样本重新开始完整 5 分钟；已经 firing 时，失败只标 unknown，不能 resolved。
6. 监控栈、wire format、scrape/push 方式与通知通道属于 Architecture / deployment。

### States and Transitions

本模块无业务状态机。一次采集只有：

| Outcome | Metric publication | Alert implication |
|---|---|---|
| success | 发布同一 Store 快照的三值 | 按当前值推进 pending/firing/resolved |
| failure before firing | 不发布业务值 | pending → unknown，连续计时清零 |
| failure after firing | 不发布业务值 | firing 保持（可附 unknown）；绝不 resolved |

### Interactions with Other Modules

- **Notification Store（唯一业务依赖）**：消费 global `query_outbox` 的 `pending_count`、
  `oldest_pending_age_seconds`、`dead_count`。
- **Operations Control**：操作员收到告警后可查询和人工重放；本模块不调用它。
- **明确排除**：attempt history、in-flight/outcome/lease 指标、per-vendor error rate、SLO dashboard、
  replay、自动修复、Delivery / Vendor Registry 查询，均不属于 MVP。

## Data Model

**无持久领域实体。** `MetricSnapshot={pending_count,oldest_pending_age_seconds,dead_count,observed_at}`
是单次采集内的只读投影；`observed_at` 标识成功观察时间，不替代 Store 权威时钟。旧快照不得作为当前
健康值重新发布。

## Edge Cases

- **If pending 集合为空**：oldest pending age 输出 `0`，series 不缺失。
- **If Store 返回负数、非有限年龄或不完整投影**：整次采集失败，不部分发布。
- **If Store 拒绝 global capability**：采集失败，不退化为 scoped 指标。
- **If Store 暂时不可用**：不输出零值或新时间戳旧样本。
- **If dead 在不足 5 分钟内恢复为 0**：告警不进入 firing。
- **If pending window 内采集失败**：不能拼接故障前后两个 `>0` 区间；下一次成功 `>0` 从零计时。
- **If firing 后采集失败**：不得 resolved；恢复语义等待下一次成功采集。

## Dependencies

- **硬依赖**：Notification Store。
- **反向依赖**：无。
- `query_outbox` 的聚合、scope 和权威年龄计算归 Store；本模块只拥有指标命名、投影和告警语义。

## Configuration

| Key | Default | Rule |
|---|---:|---|
| `DEAD_ALERT_THRESHOLD` | `0` | MVP 固定常量，不允许运行时覆盖 |
| `DEAD_ALERT_FOR` | `5m` | MVP 固定常量，不允许运行时覆盖 |

采集间隔、stale 展示、告警路由、通知通道、抑制和监控 HA 属于部署配置，但不得改变上述
threshold/duration 或失败状态机。规则缺失或试图覆盖固定值时加载失败，不得静默关闭告警。

## Integration Requirements

- 输入：`query_outbox(global, ActorContext{kind=system,capability=read_all_notifications})`。
- 成功输出：同一逻辑快照派生的三个 gauge。
- 失败输出：采集失败信号由监控平台的可用性/freshness 机制承载；它是诊断信号，不新增第四项业务指标。
- 不提供外部业务 API、CLI 或管理 UI。

## UI Requirements

**N/A — headless metrics exposition.** Dashboard 和通知通道不在 MVP 设计范围。

## Acceptance Criteria

- **RO-01 [Integration]**：**GIVEN** Store global pending count 为 N，**WHEN**成功采集，**THEN** `rc_wsman_outbox_pending=N`。
- **RO-02 [Integration]**：**GIVEN** 最老 pending 年龄为 T，**WHEN**成功采集，**THEN** age gauge 为 T；无 pending 时为 `0`。
- **RO-03 [Integration]**：**GIVEN** Store global dead count 为 N，**WHEN**成功采集，**THEN** dead gauge 为 N。
- **RO-04 [Security Negative]**：**GIVEN** ActorContext 缺 `read_all_notifications`，**WHEN**采集，**THEN**整次失败且不发布任一业务值。
- **RO-05 [Integration]**：**GIVEN** Store timeout/error 或返回非法投影，**WHEN**采集，**THEN**不发布零值、不重发旧样本、不部分发布。
- **RO-06 [Security Negative]**：**GIVEN**任一成功输出，**WHEN**检查名称、标签和值，**THEN**不含 vendor/notification/caller/payload/credential。
- **RO-07 [Logic]**：**GIVEN**成功样本连续显示 dead>0 满 5 分钟且中间无采集失败，**WHEN**规则评估，**THEN**告警进入 firing。
- **RO-08 [Logic]**：**GIVEN**采集失败，**WHEN**规则评估，**THEN**未 firing 的 pending timer 清零并进入 unknown；已 firing 告警不 resolved，直至成功采集到 0。
- **RO-09 [API Contract]**：**GIVEN**模块依赖审查，**WHEN**检查调用和持久化，**THEN**只存在 Store global query，无 attempt-history/replay、Delivery/VR 调用或本地业务状态。
- **RO-10 [Integration]**：**GIVEN** day-1 部署候选，**WHEN**检查制品，**THEN**三指标定义与固定 `dead>0 for 5m` 告警规则同时存在。

### C1–C15 Applicability

| ID | Disposition | Locus |
|---|---|---|
| C1 | Applied | single scrape + alert state contract |
| C2 | Applied | zero business writes / no stale republish |
| C3 | Applied | MetricSnapshot projection |
| C4 | N/A | no worked numerical example |
| C5 | Applied | global capability and sample validation |
| C6 | Applied | forbidden publishes no aggregate |
| C7 | N/A | read-only module |
| C8 | Applied | scrape failure vs successful sample |
| C9 | Applied | system actor only |
| C10 | Applied | Store age + successful observed time |
| C11 | Applied | system × read_all_notifications |
| C12 | N/A | fixed aggregate, no collection |
| C13 | Applied | no mutable domain entity |
| C14 | Applied | global only, no scoped fallback |
| C15 | N/A | no collection |

## Open Questions

无未决行为问题。监控产品、采集协议、规则文件格式、采集间隔和通知通道延后到 Architecture / deployment。
