# Notification Delivery Service（通知投递服务）— 设计说明

> 本文件源自 standalone 历史设计基线，现用于说明 OpenSlack monorepo 内该独立服务源码的问题拆解
> 与工程判断；模块级确定性契约仍见 `../design/cdd/`。

## 问题理解

业务系统真正需要的不是一个通用消息平台，而是一个可以“提交即忘”的可靠 HTTP 投递边界：

1. 调用方知道供应商业务 payload，应继续负责生成最终 body。
2. 服务知道哪些端点和认证材料被批准，应负责安全传输。
3. 外部 HTTP 的成功状态存在不可判定窗口，系统必须承认重复而不能宣称 exactly-once。
4. “可靠”必须包含持久状态、失败收敛、可查询、可重放与可观测，而不只是循环重试。

## 系统边界

### 解决

- API Key 认证、服务端身份推导、vendor scope 与 capability；
- 入站幂等键、稳定请求指纹和原子持久化；
- PostgreSQL outbox 调度、lease/OCC、attempt history；
- 已批准端点、静态 Header、凭证引用和幂等键映射；
- HTTPS 投递、DNS pinning、no-redirect、重试、dead；
- 运维查询、dry-run/preview、显式人工重放；
- outbox depth、oldest pending age、dead count 与告警。

### 不解决

- exactly-once、跨通知顺序和分布式事务；
- 供应商响应体解析或业务状态机；
- payload 字段映射、模板渲染、schema 转换；
- 任意目标 URL、开放 HTTP 代理；
- 自动 dead 恢复、优先级、按 vendor 分片、多区域；
- GUI、CLI、管理后台。

这些排除项不是遗漏，而是为了把第一版复杂度集中在可证伪的投递可靠性上。

## 整体架构

六个 CDD 模块是同一 Go 服务内的逻辑边界，不是六个微服务：

| 模块 | 权威职责 | 明确不拥有 |
|---|---|---|
| Caller Access | 外部 API Key、principal、scope/capability | notification/vendor 状态 |
| Vendor Registry | vendor、endpoint version、credential reference | DNS/HTTP/retry |
| Notification Store | notification、lease、attempt、replay、OCC | vendor 和 retry policy |
| Delivery | HTTP attempt、SSRF runtime、retry/dead policy | 持久状态和配置 |
| Operations Control | 查询与受守护重放组合 | 第二份状态/队列 |
| Reliability Observability | 三项全局可靠性投影 | 自动修复 |

PostgreSQL 是唯一持久状态源。API、worker、recovery 与 metrics 运行在一个部署单元中，通过内部
typed context 和 Store/Registry 接口协作。

## 主要数据流

### 接收

```text
Bearer key
  -> Caller Access authenticates and narrows vendor scope
  -> Vendor Registry confirms active vendor without enumeration leakage
  -> composition creates ValidatedIntake
  -> Notification Store commits notification + outbox visibility
  -> 202 {notification_id}
```

### 投递

```text
Store claim + lease
  -> latest active Vendor snapshot
  -> credential resolution in memory
  -> resolve all A/AAAA + address policy + pinned dial
  -> one HTTP request
  -> Store succeed / retry / actual-result die
```

### 人工恢复

```text
operator query -> preview explicit ids -> execute explicit id+version
  -> Caller Access re-authenticates
  -> Store OCC replay transition
  -> new delivery cycle
```

## 可靠性与失败处理

投递语义为 **at-least-once**：

- HTTP 成功、失败或未知结果都进入 append-only attempt history。
- 408、429、5xx、DNS/connect/TLS/timeout 等瞬态失败使用 full-jitter 退避。
- 其他 4xx、1xx 和 3xx 是永久失败；3xx 不跟随。
- 当前 cycle 最多 25 次、最长 24 小时；任一先到即进入 `dead`。
- cutoff 前开始但 cutoff 后才完成的 retryable attempt，在本次结果写回中以
  actual-result `deadline_exceeded` 原子进入 `dead`，保留 status/error 并计数。
- 供应商恢复后只能由授权操作员重放；preview 不是 execute 的锁或承诺。

供应商是否 honor 幂等键不受本服务控制。若供应商不支持，重复副作用是公开风险，需由业务对账。

## 安全判断

- 调用方不能提交 URL、认证 Header 或 credential reference。
- Registry 只保存 opaque reference；Delivery 在单次 attempt 内解析并在结束时丢弃。
- 所有 DNS 地址必须通过公网/批准例外校验，socket 只连接验证后的 IP，同时保持原 hostname TLS 校验。
- 禁止环境代理、自动 redirect、响应体读取和 secret/payload 日志。
- 不存在与越权使用合并错误，避免枚举 vendor 或 notification。
- API Key 只存 HMAC digest，支持撤销、轮换、限流和 scope attenuation。

## 中间件与替代方案

### 选择 PostgreSQL

同库可以原子承载 intake、outbox、lease、attempt、vendor 配置、查询与 dead 状态；
`FOR UPDATE SKIP LOCKED` 支持多个 worker 安全竞争。

- 不选 SQLite：不作为并发 worker 的生产方案。
- 不同时支持 MySQL：技术可行，但双实现对当前独立服务边界没有足够收益。
- 不在 day-1 使用 Kafka/RabbitMQ：若直接作为工作队列会产生数据库/队列双写；若增加 outbox relay，
  则引入当前流量尚未证明需要的基础设施。

### 选择 Go 单体服务

Go 的 `net/http`、自定义 `Transport`、`netip`、并发模型和单二进制部署适合本项目；六个模块保留为
包/接口边界。Python/TypeScript 能更快搭 CRUD，但在 pinned dial、worker 生命周期和类型化内部契约上
需要更多运行时约束。Rust 提供更强静态安全，但对本 MVP 的迭代成本过高。

### 选择 Prometheus

MVP 只发布 pending 数、最老 pending 年龄和 dead 数三项无业务标签的全局 gauge。Prometheus 使用标准
text exposition 与 pull scrape，能够用同一套配置在 Compose 中复现采集、`for` 告警时序和规则单测；
应用本身不缓存指标，Store 查询失败时整个 scrape 返回 `503`，避免把未知状态伪装成健康零值。

- 若部署环境已有 Prometheus-compatible 或云托管监控，可直接抓取相同 `/metrics`，无需运行仓库内的
  Prometheus server；告警接收与通知渠道由部署方负责。
- logs-only 便于故障取证，但不能等价提供积压趋势、连续 `for` 计时和 scrape availability 语义，因此
  不是可靠性指标的替代品。
- OpenTelemetry Collector 适合需要统一 metrics/traces/logs 或多后端导出时引入；本 MVP 没有 tracing
  或多后端需求，day-1 增加 collector 只会扩大部署与故障面。
- Alertmanager 解决告警路由而非指标采集；通知渠道不属于本服务边界，因此不随 MVP 部署。

## 演进

演进由证据触发，不承诺固定顺序：

| 观测信号 | 候选演进 |
|---|---|
| 最老 pending 年龄持续升高 | 增 worker、LISTEN/NOTIFY、调度公平性 |
| 单 vendor 占用 worker | per-vendor concurrency/限流 |
| 表增长影响查询/维护 | retention、分区、归档 |
| API Key 管理成为风险 | OIDC/JWT 或 mTLS |
| 单库/单区域成为已测瓶颈 | 分片；多区域须修改宪法与一致性模型 |

没有基准测量前不承诺吞吐/延迟 SLA；测试策略先定义测量方法，实施阶段产生第一份基线。
