# 分批次开发计划 — MVP 实现

> 本计划把已批准的 Architecture（6 模块 CDD / 290 canonical AC / OpenAPI 3.1 / CTRL-001..024）
> 映射为可逐批授权、逐批审查的实现批次。**本文件不授权任何代码**；每个批次开工前仍需所有者
> 单独授权。当前 `production/stage.txt` = Implementation；B1、B2 已完成并归档，B3–B6 待授权后开工。

## 实现进度

- CP0 — 已完成
- B1 — 已完成并归档（`8cbd0eb`；机械核验 + `-race` 实证；评审方法见
  [`implementation-review-archive.md`](../memory_bank/t3_archive/reviews/implementation-review-archive.md)）
- B2 — 已完成并归档（`8cbd0eb`；同上；79 NS AC 核心路径有测试证据，边界组合归 B6 对账）
- B3 — 未授权
- B4 — 未授权
- B5 — 未授权
- B6 — 未授权

## 前置条件（任何批次开工前）

1. Architecture → Pre-Implementation gate 未运行；B1–B2 经所有者逐批单独授权开工。
   B3+ 开工前由所有者决定是否补跑该 gate 并记录证据。
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

- [ ] CI 全绿（含 `-race`）
- [ ] 本批映射 AC 100% 有通过中的测试证据（unit 或 integration），AC 数量与 tr-registry 对账无漂移
- [ ] 无 NEEDS REVISION 残余；或残余经所有者书面裁决（记录进 archive）
- [ ] OpenAPI contract test 通过（涉及公开端点的批次）
- [ ] 无 CTRL-024 / CTRL-016 违规；无数值 SLA 承诺
- [ ] 评审证据已归档；tr-registry 的 `planned_test_types` 如有实现证据更新，同批完成（Change Rule）

B1、B2 已实现并满足上述通过标准（B2 的 AC 覆盖估计见本节上方注释）。

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
`/healthz`、`/metrics` 占位）；pgx v5 连接池；golang-migrate v4 迁移（notifications、outbox
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
- [x] 79 条 NS AC 中核心行为路径有测试证据；并发竞态用例在 `-race` 下稳定通过（边界组合归 B6，见下注）
- [x] attempt history 任何路径不可 UPDATE/DELETE（触发器集成测试 + 代码扫描双重验证）
- [x] not-found/越权统一响应不泄露存在性（负向测试）

> 注：79 条 AC 中核心行为路径有单元/集成测试；clock-unavailable、cursor 漂移全矩阵、batch 边界全组合等边界项当前为 code-only，约定在 B6 端到端硬化时补齐对账（见评审档案 AC 覆盖估计）。

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
- [ ] 167/167 AC 有测试证据
- [ ] OpenAPI contract test 覆盖全部管理端点与错误 schema
- [ ] HMAC/pepper 生命周期（含 emergency bulk-revoke 单事务）有集成测试

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
- [ ] 20/20 DL AC + B-01 回归测试通过
- [ ] SSRF 负向用例全部拒绝且无响应体读取
- [ ] 计时语义（cutoff、budget、退避上界）注入时钟测试，无 wall-clock sleep 脆弱用例

### B5 — Operations Control + Reliability Observability

**交付物**：operator 查询（singleton/list/preview，闭合 allowlist 投影 + `input_index`
关联）；显式 id+version 人工重放（重新认证 + Store OCC，preview 不构成承诺）；三个全局
gauge（pending 深度、最老 pending 年龄、dead 计数，no-pending=0）；固定 `dead>0 for 5m`
告警评估；低基数 label 约束。

**专项审查**：14 条 OC AC + 10 条 RO AC；重放授权矩阵（capability 收窄）；metrics 基数审计；
scrape 失败窗口语义测试。

**通过标准（增量）**：
- [ ] 24/24 AC 有测试证据
- [ ] 重放端到端（dead → preview → execute → 新 cycle）集成通过
- [ ] 无任何自动恢复/自动重放路径（代码评审确认）

### B6 — 端到端硬化与部署包

**交付物**：Dockerfile + docker-compose（服务 + PostgreSQL 18.4）；故障注入套件（崩溃在
send 后 commit 前、PostgreSQL 重启、worker 抢占）；容量基线测量（`test-strategy.md` 场景
12–14：drain rate / oldest age / `DEADLINE_CLAIM_BUDGET` 在 backlog pressure 下的经验证明——
完成 advisory 2 的 deferred 部分）；runbook 可执行化演练（pepper 轮换/吊销流程）。

**专项审查**：全量 290 AC 对账（tr-registry 逐 family）；公开 wire 全路径 contract test；
`ai-usage.md` 实现阶段记录完整性；README 运行说明与真实启动命令一致性。

**通过标准（最终）**：
- [ ] 290/290 canonical AC + 4/4 NSBR 有通过证据；CI 全绿且可复现
- [ ] crash-after-send 不产生丢失，仅产生公开披露的重复（at-least-once 语义实证）
- [ ] 24h 收敛在 N 行 backlog 下经验成立（或触发 Evolution Boundaries 记录）
- [ ] docker-compose 一键启动；README 运行说明不再含"未建立"字样
- [ ] 部署包实例化 pepper 生命周期（advisory 1 deferred 部分）完成并演练

## 风险与纪律

- **批次边界即授权边界**：跨批发现的缺口记入下一批范围冻结，不在本批顺手扩张。
- **评审独立性**：每批 fresh-session 独立评审；同线程复审结论不得标记 APPROVED（历史先例：
  VR re-review #1–#4 same-thread 均只记 NEEDS REVISION）。
- **append + supersede**：实现评审证据一律追加；改已审 artifact 须新一轮评审并重记 SHA。
- **不确定就问**：任何超出本计划的行为（新依赖、新平台、新 AC）先问所有者，先改 tr-registry
  再动代码（Change Rule）。
