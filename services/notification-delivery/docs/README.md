# Notification Delivery Service 文档索引

> **Imported historical record.**
>
> Imported history is retained for provenance.
> It is not the current OpenSlack roadmap, module status, runtime admission,
> release authority, or production-readiness source.

本索引区分当前服务实现、当前本地证据和导入的 standalone 历史。OpenSlack 产品定位、模块状态、
runtime admission、发布与 live 状态以仓库根文档和治理 receipt 为准：

- [OpenSlack 产品页](../../../design/cdd/workstreams/notification-delivery/README.md)
- [跨进程集成契约](../../../docs/architecture/integrations/notification-delivery.md)
- [根级证据索引](../../../docs/evidence/notification-delivery-evidence.md)

## Current Implementation Docs

| 主题       | 文档                                                |
| ---------- | --------------------------------------------------- |
| 服务设计   | [design.md](design.md)                              |
| HTTP API   | [OpenAPI](api/openapi.yaml)                         |
| 主架构     | [architecture.md](architecture/architecture.md)     |
| 数据模型   | [data-model.md](architecture/data-model.md)         |
| ADR 注册表 | [adr-registry.yaml](architecture/adr-registry.yaml) |
| 安全实现   | [threat-model.md](security/threat-model.md)         |
| 运维手册   | [runbook.md](operations/runbook.md)                 |
| 测试策略   | [test-strategy.md](testing/test-strategy.md)        |

这些文档说明 Go 服务内部如何实现；它们不声明 OpenSlack 模块成熟度、runtime admission 或发布状态。

## Current Evidence

| 证据         | 文档                                                           |
| ------------ | -------------------------------------------------------------- |
| AC 映射      | [ac-evidence.json](testing/ac-evidence.json)                   |
| 验收报告     | [acceptance-report.json](testing/acceptance-report.json)       |
| 故障演练     | [fault-drill-report.md](testing/fault-drill-report.md)         |
| PITR 演练    | [pitr-report.md](testing/pitr-report.md)                       |
| 容量基线     | [capacity-report.md](testing/capacity-report.md)               |
| 标记扫描     | [marker-scan-report.md](testing/marker-scan-report.md)         |
| IB4 本地报告 | [ib4-r1-local-report.json](testing/ib4-r1-local-report.json)   |
| 工作区清单   | [workspace-manifest.sha256](testing/workspace-manifest.sha256) |

这些证据记录服务实现和本地验收，不等于 PX2、外部 qualification、IB7、release、
production readiness 或 `LIVE_VERIFIED`。

## Governance and Imported History

| 历史材料            | 入口                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B1–B6 历史开发计划  | [development-plan.md](development-plan.md)                                                                                 |
| AI 使用与规划演进   | [ai-usage.md](ai-usage.md)                                                                                                 |
| CDD 设计索引        | [module-index.md](../design/cdd/module-index.md)                                                                           |
| 根 T0 活动上下文    | [active_context.md](../../../memory_bank/t0_core/active_context.md)                                                        |
| 根项目状态投影      | [current_state.md](../../../memory_bank/t0_core/current_state.md)                                                          |
| Standalone 阶段标记 | [stage.txt](../production/stage.txt)                                                                                       |
| CDD 评审归档        | [review-archive.md](../design/cdd/reviews/review-archive.md)                                                               |
| 架构评审归档        | [architecture-review-archive.md](architecture/architecture-review-archive.md)                                              |
| 实现评审历史        | [notification-delivery-implementation.md](../../../memory_bank/t3_archive/reviews/notification-delivery-implementation.md) |
| 项目评审索引        | [review-index.md](../../../memory_bank/t3_archive/reviews/review-index.md)                                                 |
| 历史 gate 记录      | [notification-delivery.md](../../../memory_bank/t3_archive/gate_runs/notification-delivery.md)                             |

以上材料用于 governance、provenance 和历史追溯，不是 OpenSlack runtime admission、发布或生产就绪
事实源。仓库只保留根 `memory_bank/`；原 service-local Memory Bank 文本可通过 Git 历史恢复，
不另建重复原文归档。
