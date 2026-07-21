# rc_wsman — API 通知投递服务

> 文档先行的 take-home assignment。当前只完成需求、规格与架构设计；MVP 实现尚未开始。

## 30 秒了解

企业内部业务系统把已经按供应商格式构造好的 HTTP body 交给本服务，本服务在一次 PostgreSQL
事务中持久化通知与 outbox 可见性，然后以 **at-least-once** 语义投递到服务端批准的供应商端点。
业务系统收到 `202 Accepted` 后无需等待供应商响应，也不需要自行处理重试、死信和人工恢复。

本系统解决：

- 原子接收、入站幂等、异步投递、有界重试与 `dead` 状态；
- 供应商端点/凭证引用的受控配置与 SSRF 防护；
- 状态查询、授权人工重放和 day-1 可靠性指标。

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

## 深入阅读

- [完整设计说明](docs/design.md)
- [OpenAPI 契约](docs/api/openapi.yaml)
- [主架构](docs/architecture/architecture.md)
- [数据模型](docs/architecture/data-model.md)
- [安全威胁模型](docs/security/threat-model.md)
- [运维手册](docs/operations/runbook.md)
- [测试策略](docs/testing/test-strategy.md)
- [分批次开发计划](docs/development-plan.md)
- [AI 使用说明](docs/ai-usage.md)
- [六模块 CDD 索引](design/cdd/module-index.md)
- [ADR 注册表](docs/architecture/adr-registry.yaml)

## 作业要求对照

| 要求 | 入口 |
|---|---|
| 问题理解、系统边界 | 本 README、[设计说明](docs/design.md) |
| 整体架构与核心设计 | [主架构](docs/architecture/architecture.md) |
| 可靠性与失败处理 | 本 README、[设计说明](docs/design.md#可靠性与失败处理) |
| 关键取舍与演进 | 本 README、四份 ADR |
| 中间件理由与替代方案 | [ADR-0001](docs/architecture/adr-0001-postgresql-outbox.md) |
| AI 帮助、未采纳建议、自主决策 | [AI 使用说明](docs/ai-usage.md) |
| MVP 代码与运行说明 | **仅有 CP0 测试基线骨架**（`internal/delivery/backoff.go` + CI）；业务源码尚未授权建立 |

## 当前状态

- 权威阶段：[`production/stage.txt`](production/stage.txt)（= Architecture；Architecture → Pre-Implementation gate 未运行）
- 设计状态：以 [`design/cdd/module-index.md`](design/cdd/module-index.md) 为准
- 实现状态：无业务源码、无 migration、无容器。经授权的 Pre-Implementation CP0 骨架已存在——
  `go.mod`（majors-only，无 go.sum）、`internal/delivery/backoff.go` full-jitter leaf + 单测、
  `tests/` 布局与 `.github/workflows/tests.yml` CI；本地无 Go 工具链，骨架为 authored-but-not-compiled，
  由 CI 执行 `go mod tidy` / `go vet` / `go test -race`
- 未来运行入口：实现阶段建立后补充；当前文档不伪造启动命令或运行证据
