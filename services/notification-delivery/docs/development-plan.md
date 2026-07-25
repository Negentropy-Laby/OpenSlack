# 分批次开发计划 — MVP 实现

> 本计划把已批准的 Architecture（6 模块 CDD / 290 canonical AC / OpenAPI 3.1 / CTRL-001..024）
> 映射为可逐批授权、逐批审查的实现批次。所有者已明确授权并完成 B1–B6 实施。当前
> `production/stage.txt` = Implementation；全量机械验收、逐批 review 与最终 cross-batch fresh
> independent re-review 已通过，当前为本地 submission-ready。

## 实现进度

- CP0 — 已完成
- B1/B2 — `APPROVED`（fresh independent closure review）
- B3 — `APPROVED`（15/15 CA + 152/152 VR）
- B4 — `APPROVED`（20/20 DL）
- B5 — `APPROVED`（14/14 OC + 10/10 RO）
- B6 — `APPROVED`（部署、故障、容量、PITR、pepper 和 4/4 NSBR）
- B1–B6 cross-batch closure — `APPROVED`（fresh independent re-review；0 blocker）

B1–B6 共 290 项 canonical AC 与四项 NSBR 的逐项登记由
[`ac-evidence.json`](testing/ac-evidence.json) 和 `tests/contracts/ac_evidence_test.go` 机械校验。
2026-07-22 已在 Go 1.26.5 + PostgreSQL 18.4 完成 build/vet/race、OpenAPI、Prometheus、Compose、
故障、容量与恢复验收；[`acceptance-report.json`](testing/acceptance-report.json) 不声称未运行的
GitHub-hosted CI 或生产部署。

B3/B4 实施前的 AI 辅助计划、最终采纳项与人工修正已精炼至
[AI 使用与规划演进说明](ai-usage.md#规划输入与实际偏差)；本地 `.claude/` 原稿不具备设计或状态权威。

## 前置条件（任何批次开工前）

1. Architecture → Pre-Implementation gate 未运行；B1–B6 均由所有者明确授权实施。本轮不把
   该历史缺口伪装成已运行 gate。
2. Go 1.26.5 工具链环境就绪（本地或 CI runner）；`go mod tidy` 生成 `go.sum`，固化 patch 版本。
3. 本批次范围冻结：列出本批覆盖的 AC ID 清单（引用 `architecture/tr-registry.yaml` 的 family），
   由所有者批准；范围外行为不得混入。
4. `standards/technical-preferences.md` 的包边界与禁用模式为本批硬约束。

## 通用审查流程（每批必走，追加记录不覆盖）

1. **实现 + CI 绿**：`.github/workflows/tests.yml`（`go mod tidy` 无 diff、`go vet ./...`、
   `go test -race ./...`）全绿，且本批新增测试纳入 CI。
2. **机械自检**：CTRL-024 扫描（无 Kafka/Redis/独立 DLQ/调度平台/服务网格依赖，无 lease 续约、
   无自动 dead 重放）；CTRL-016 扫描（secret 值不进 Store/logs/metrics/audit/response）；
   `entities.yaml` Authority Rule 核验（每个标识符仍只有一个行为权威，新标识符须同批注册）。
3. **fresh-session 独立代码评审（read-only）**：对照本批 CDD 的 canonical AC 逐条核验测试证据；
   verdict 为 APPROVED / NEEDS REVISION；blocking findings 只允许一轮 bounded correction，
   修不完的提交所有者裁决（沿用上批 B-01 先例）。
4. **契约一致性**：公开端点对 `docs/api/openapi.yaml` 跑 contract test（请求/响应 schema、
   闭合错误集、状态码）；跨模块接口对照 `entities.yaml` 权威表，消费者不得越位。
5. **证据归档**：批次评审记录追加到对应 archive（`design/cdd/reviews/review-archive.md` 或新建
   实现评审档案），含 SHA-256、verdict、AC 覆盖计数；`docs/ai-usage.md` 追加本批 AI 使用记录。

## 通用通过标准（每批）

- [x] CI 等价本地命令全绿（含 `-race`；GitHub 托管 run 尚未发生）
- [x] B1–B6 的 290 AC + 4 NSBR 100% 有现存测试证据，数量与 tr-registry 对账无漂移
- [x] 逐批 review 无未关闭 NEEDS REVISION blocker；修正链与最终 verdict 已追加归档
- [x] OpenAPI contract test 通过（涉及公开端点的批次）
- [x] 无 CTRL-024 / CTRL-016 违规；无数值 SLA 承诺
- [x] 实现与机械验收证据已归档；290+4 证据映射已建立

逐批及最终 cross-batch 独立评审均已完成；本地提交状态为 submission-ready。GitHub-hosted CI、
commit/push 与生产部署仍不属于本轮已执行证据。

## 批次划分（沿模块依赖 DAG）

| 批次 | 范围 | 依赖 | AC 家族（数量） |
|---|---|---|---|
| CP0（已完成） | 测试基线、`internal/delivery/backoff.go`、CI、accessibility | — | — |
| B1 | 工程基座与数据层（已完成） | CP0 | APP lifecycle、迁移不变量（非 AC 计数） |
| B2 | Notification Store 核心（已完成） | B1 | NS（79） |
| B3 | Caller Access + Vendor Registry | B1（契约层对齐 B2） | CA（15）+ VR（152） |
| B4 | Delivery | B2 + B3 | DL（20） |
| B5 | Operations Control + Reliability Observability | B2（+B3 只读） | OC（14）+ RO（10） |
| B6 | 端到端硬化与部署包 | B1–B5 | 4 NSBR + 容量基线 |

### B1 — 工程基座与数据层

**交付物**：`go.sum` 固化；chi v5 路由骨架 + App 生命周期（启动配置加载、优雅关闭、
`/health/live`、`/health/ready`、`/metrics`）；pgx v5 连接池；golang-migrate v4 迁移（notifications、outbox
可见性、access_keys、vendors/endpoint_versions、attempt history、admin audit/receipt——按
`data-model.md` 的逻辑模型与迁移不变量）；结构化配置（`env://` allowlist，含
`API_KEY_PEPPER_ACTIVE/PREVIOUS` 的 fail-closed 启动校验）。

**专项审查**：迁移 SQL 逐表对照 `data-model.md`（列、约束、索引、OCC version 列、append-only
表无 UPDATE 路径）；配置加载的 fail-closed 行为有负向测试。

**通过标准（增量）**：
- [x] 迁移 up/down 在空库与重复执行下幂等；与 data-model.md 逐表对账零偏差
- [x] pepper env 缺失/双丢失时启动 fail-closed（config.Load 报错、服务不启动），有测试；
  auth `503` 语义随 B3 认证落地后验证
- [x] 无任何业务行为混入（本批不实现任何 AC 业务路径）

**评审证据**：[`implementation-review-archive.md`](../memory_bank/t3_archive/reviews/implementation-review-archive.md) §B1 + B2 Review。

### B2 — Notification Store 核心

**交付物**：intake 原子提交（notification + outbox 可见性单事务）；入站幂等（键 + 不可变
`request_fingerprint`，同键异指纹 `409` 语义在 Store 层的判别）；`FOR UPDATE SKIP LOCKED`
claim + 30s lease；OCC 版本校验的结果写回（succeed/retry/die/replay 判别联合）；lease 回收
（system actor，crash-after-send 收敛）；append-only attempt history + cursor 分页查询；
scoped/global `query_outbox`、`list_dead` snapshot 语义。

**专项审查（fresh-session）**：79 条 NS AC 逐条对账；并发测试——双 worker 竞争同一行、
commit-outcome-unknown 重试收敛、replay 与 in-flight 的 OCC 竞态；`deadline_exceeded` 原子
die 的 Store 写路径（为 B4 的 B-01 做准备）。

**通过标准（增量）**：
- [x] 79/79 NS AC 有机器可校验的测试证据；并发竞态与每测试独立 PostgreSQL schema 在默认并行
  `-race -count=5` 下稳定通过
- [x] attempt history 任何路径不可 UPDATE/DELETE（触发器集成测试 + 代码扫描双重验证）
- [x] not-found/越权统一响应不泄露存在性（负向测试）

> 原 B2 `code-only` / deferred 缺口已在 B1–B4 closure 中补齐：数据库时钟、commit taxonomy、
> cursor/scope/page limit、claim/lease/OCC、replay 竞态、结果联合和 B-01 均纳入实际测试证据。

### B3 — Caller Access + Vendor Registry

**交付物**：Bearer API Key 认证（HMAC-SHA-256 digest 查库、pepper 版本化、撤销/轮换、
限流、scope attenuation）；服务端 principal 推导（拒自报 caller_id）；vendor 管理 API
（register/update/activate/disable/rotate，AdminCommandReceipt 幂等、AdminAuditEvent、
闭合 AdminCommandError(13)/ReadError(9)）；EndpointVersion append-only；per-attempt
`latest_active` ConfigSnapshot（Delivery/Historical 投影分离）；防枚举统一
`404 VendorUnavailable`。

**专项审查（fresh-session + 对抗）**：152 条 VR AC + 15 条 CA AC；密钥材料零落盘/零日志扫描；
防枚举时序与错误体一致性；管理操作幂等重放（同 key 同结果、同 key 异指纹冲突）。

**通过标准（增量）**：
- [x] 167/167 AC 有机器可校验的实际测试证据
- [x] OpenAPI request/response contract test 覆盖全部 B3 路由及主要错误分支
- [x] HMAC/pepper 生命周期、撤销/轮换、权限、限流与并发有单元/集成测试

### B4 — Delivery

**交付物**：worker 循环（oldest-eligible claim、`cycle_send_cutoff` + claim budget）；
SSRF 安全传输（全量 A/AAAA 解析 → 地址策略 → pinned-IP dial + 原 hostname TLS；禁环境代理、
不跟 redirect、不读响应体）；full-jitter 重试（复用 CP0 backoff leaf）；失败收敛 25 次/24h；
**B-01**：cutoff 后完成的 retryable actual result 在当前写回原子 `die(deadline_exceeded)`；
6 项 policy_termination（发送前确定性终止、不计数）。

**专项审查（fresh-session + 对抗）**：SSRF 对抗用例（DNS rebinding、IPv6 映射地址、
redirect 诱导、metadata endpoint）；B-01 决定性 trace 复现测试（cutoff-ε 场景）；
20 条 DL AC；与 VR 快照、Store 写回的契约边界（mock 只用于进程内接口，数据库用真实实例）。

**通过标准（增量）**：
- [x] 20/20 DL AC + B-01 回归测试通过
- [x] SSRF 负向用例覆盖 DNS rebinding、地址类别、redirect、proxy、TLS hostname，且不读取响应体
- [x] 计时语义（cutoff、budget、退避上界）使用注入时钟；worker 并发与 shutdown 路径有测试
- [x] Delivery 与真实 PostgreSQL Store + Vendor Registry 的端到端集成测试通过

### B5 — Operations Control + Reliability Observability

**交付物**：operator 查询（singleton/list/preview，闭合 allowlist 投影 + `input_index`
关联）；显式 id+version 人工重放（重新认证 + Store OCC，preview 不构成承诺）；三个全局
gauge（pending 深度、最老 pending 年龄、dead 计数，no-pending=0）；固定 `dead>0 for 5m`
告警评估；低基数 label 约束。

**专项审查**：14 条 OC AC + 10 条 RO AC；重放授权矩阵（capability 收窄）；metrics 基数审计；
scrape 失败窗口语义测试。

**通过标准（增量）**：
- [x] 24/24 AC 有测试证据
- [x] 重放端到端（dead → preview → execute → 新 cycle）集成通过
- [x] 无任何自动恢复/自动重放路径（静态边界测试确认）

### B6 — 端到端硬化与部署包

**交付物**：Dockerfile + docker-compose（服务 + PostgreSQL 18.4）；故障注入套件（崩溃在
send 后 commit 前、PostgreSQL 重启、worker 抢占）；容量基线测量（`test-strategy.md` 场景
12–14：drain rate / oldest age / `DEADLINE_CLAIM_BUDGET` 在 backlog pressure 下的经验证明——
完成 advisory 2 的 deferred 部分）；runbook 可执行化演练（pepper 轮换/吊销流程）。

**专项审查**：全量 290 AC 对账（tr-registry 逐 family）；公开 wire 全路径 contract test；
`ai-usage.md` 实现阶段记录完整性；README 运行说明与真实启动命令一致性。

**通过标准（最终）**：
- [x] 290/290 canonical AC + 4/4 NSBR 有本地通过证据；GitHub-hosted CI 明确未运行
- [x] crash-after-send 不产生丢失，仅产生公开披露的重复（at-least-once 实证）
- [x] deadline Path A/B 的 blocking N=1、N=W 通过，并记录更高 N 的非 SLA 基线
- [x] docker-compose 一键启动；app/PostgreSQL/Prometheus health 与 scrape 通过
- [x] pepper active/previous、fail-closed、bulk revoke 和旧 key 失效完成演练
- [x] physical backup + WAL + age v1.3.1 + target-time restore 完成隔离演练

## 风险与纪律

- **批次边界即授权边界**：跨批发现的缺口记入下一批范围冻结，不在本批顺手扩张。
- **评审独立性**：每批 fresh-session 独立评审；同线程复审结论不得标记 APPROVED（历史先例：
  VR re-review #1–#4 same-thread 均只记 NEEDS REVISION）。
- **append + supersede**：实现评审证据一律追加；改已审 artifact 须新一轮评审并重记 SHA。
- **不确定就问**：任何超出本计划的行为（新依赖、新平台、新 AC）先问所有者，先改 tr-registry
  再动代码（Change Rule）。
