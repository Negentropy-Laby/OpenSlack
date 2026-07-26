# Notification Delivery Service（通知投递服务）

> 独立仓库阶段的 B1–B6 实现、本地机械验收和独立评审结果已作为历史基线导入 OpenSlack
> monorepo。当前产品化与发布边界仍是仓库内源码与验证：OpenSlack client/queue 集成代码已经
> 存在，但该独立进程和 Go module 尚未完成 registry registration、外部配置、service
> admission/activation、live deployment 或 release。集成状态与治理边界见
> [OpenSlack 集成指南](../../docs/developer/notification-delivery-integration.md)。

`rc_wsman` 仅作为既有数据库/迁移、指标与告警、wire schema/fingerprint、测试 fixture、
Canary/OpenAPI 示例及历史 provenance 标识保留；它不是当前 display name。

## 30 秒了解

企业内部业务系统把已经按供应商格式构造好的 HTTP body 交给本服务，本服务在一次 PostgreSQL
事务中持久化通知与 outbox 可见性，然后以 **at-least-once** 语义投递到服务端批准的供应商端点。
业务系统收到 `202 Accepted` 后无需等待供应商响应，也不需要自行处理重试、死信和人工恢复。

已落地的 MVP 解决：

- 原子接收、入站幂等、异步投递、有界重试与 `dead` 状态；
- 供应商端点/凭证引用的受控配置与 SSRF 防护；
- 授权运维查询、preview/execute 人工重放、三项可靠性指标与固定 dead 告警；
- lease recovery、pepper generation 启动校验、Compose/Prometheus 和隔离 PITR 演练。

本系统不解决：

- exactly-once、跨通知排序、响应驱动业务分支；
- payload 模板、字段映射、schema 转换和任意 URL 代理；
- 自动重放、多区域 active-active、Kafka 骨干和微服务拆分。

## 3 分钟了解设计

```text
Internal caller / operator
          │  HTTPS /v1
          ▼
┌──────────────────── one Go service / one deployment unit ────────────────────┐
│ Caller Access ──► Vendor Registry                                            │
│       │                 │ latest approved snapshot                           │
│       ▼                 ▼                                                    │
│ Notification Store ◄── Delivery worker ── safe HTTPS ──► External vendor     │
│       ├── Operations Control                                                 │
│       └── Reliability Observability + lease recovery + metrics               │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ one transaction / pgx
                    ┌───────────▼────────────┐
                    │ PostgreSQL only truth │
                    │ notification rows are │
                    │ transactional outbox  │
                    └────────────────────────┘
```

### 可靠性语义

- **接收保证**：只有 notification 与 outbox 可见性同一事务提交成功后才返回 `202`。
- **去重保证**：同 caller、同 `Idempotency-Key`、同指纹返回原 notification；同键异指纹返回 `409`。
- **投递保证**：at-least-once。网络结果未知时允许重试，因此供应商可能收到重复请求。
- **失败收敛**：最多 25 次或 24 小时；达到边界后进入 `dead`，告警并等待人工重放。
- **截止收敛**：临近 24 小时才完成的 retryable attempt 在当前结果写回中原子进入 `dead`，不再依赖第二次 claim。

### 核心取舍

| 选择 | 原因 | 未采用方案 |
|---|---|---|
| PostgreSQL transactional outbox | 接收、调度状态、attempt history 与 DLQ 可在单库原子维护 | 裸 Kafka/RabbitMQ 会引入双写或 relay 复杂度 |
| at-least-once | 外部 HTTP 无法在崩溃/超时下证明 exactly-once | at-most-once 会丢失付款/库存类关键通知 |
| dead 行即 DLQ + 人工重放 | 状态可查询、恢复动作可授权和审计 | 自动重放可能在供应商仍异常时扩大副作用 |
| 一个 Go 服务、六个逻辑模块 | 降低部署与运维面，同时保持状态/信任边界清晰 | day-1 微服务拆分 |
| 配置端点 + DNS pinning | 阻止调用方把系统变成开放代理 | 调用方自定 URL、自动 redirect |
| Prometheus pull + 三项全局指标 | 标准 exposition、告警规则和时序测试可在本地复现，且不引入业务标签 | 生产可由已有 Prometheus-compatible/托管监控抓取同一 `/metrics`；logs-only 不能等价替代告警时序，OpenTelemetry Collector 延后到确有统一遥测需求时 |

## 深入阅读

- [服务文档索引](docs/README.md)
- [完整设计说明](docs/design.md)
- [OpenAPI 契约](docs/api/openapi.yaml)
- [主架构](docs/architecture/architecture.md)
- [数据模型](docs/architecture/data-model.md)
- [安全威胁模型](docs/security/threat-model.md)
- [运维手册](docs/operations/runbook.md)
- [测试策略](docs/testing/test-strategy.md)
- [Standalone 历史分批次开发计划](docs/development-plan.md)
- [AI 使用与规划演进说明](docs/ai-usage.md)
- [六模块 CDD 索引](design/cdd/module-index.md)
- [ADR 注册表](docs/architecture/adr-registry.yaml)

## Standalone 历史要求与证据入口

| 要求 | 入口 |
|---|---|
| 问题理解、系统边界 | 本 README、[设计说明](docs/design.md) |
| 整体架构与核心设计 | [主架构](docs/architecture/architecture.md) |
| 可靠性与失败处理 | 本 README、[设计说明](docs/design.md#可靠性与失败处理) |
| 关键取舍与演进 | 本 README、四份 ADR |
| 中间件理由与替代方案 | [ADR-0001](docs/architecture/adr-0001-postgresql-outbox.md) |
| AI 帮助、未采纳建议、自主决策 | [AI 使用说明](docs/ai-usage.md) |
| MVP 代码与运行说明 | B1–B6 已落地；290+4 映射见 [AC 证据清单](docs/testing/ac-evidence.json)，运行证据见 [验收报告](docs/testing/acceptance-report.json) |

## 当前仓库边界

- Standalone 历史阶段：[`production/stage.txt`](production/stage.txt)（= Implementation）
- Standalone 历史设计状态：以 [`design/cdd/module-index.md`](design/cdd/module-index.md) 为准
- Standalone 历史实现状态：B1–B6 代码、迁移、全部公开 HTTP 契约、worker/recovery、
  Prometheus、部署与隔离演练已机械闭合；B1/B2、B3、B4、B5、B6 及最终 cross-batch
  re-review 均为 **APPROVED**（0 blocker）。
- 平台入口：`/health/live`、`/health/ready`、`/health/version`、`/metrics`；业务入口以
  [`docs/api/openapi.yaml`](docs/api/openapi.yaml) 为准。
- 一键运行：`docker compose --env-file deploy/local.env.example up --build --wait`。示例 secret 仅供
  本地验收；生产必须外部注入。
- 完整本地校验：`go build ./... && go vet ./... && go test -race ./...`；稳定性复核使用
  `go test -race ./... -count=5`。Prometheus 与 PITR 命令见[运维手册](docs/operations/runbook.md)。
- [容量报告](docs/testing/capacity-report.md)是当前机器基线，不是 SLA。
