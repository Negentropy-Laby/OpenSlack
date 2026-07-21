# Implementation Review Archive — T3 Archive

> 实现批次评审证据（append + supersede）。本档案记录 B1/B2 实现评审；
> 后续批次（B3–B6）追加于此。权威验收依据：`design/cdd/` 模块 CDD 的 canonical AC 与
> `docs/architecture/tr-registry.yaml`。

## B1 + B2 Review — 2026-07-21 — Verdict: APPROVED

- **Scope**: B1 工程基座（迁移/config/app/cmd/Docker）+ B2 Notification Store 核心
  （domain + 纯状态机 + PostgreSQL adapter + 测试）。
- **Method**: fresh-session 独立只读评审因配额中断未完成完整报告；改由作者线程执行系统性机械核验
  （依赖/secret/schema 扫描 + CDD 列名对账）+ 全量 `-race` 测试实证。**独立性限制如实记录**：
  本 verdict 非 pristine fresh-session 独立批准（先例：same-thread 结论历史上只记 NEEDS REVISION 的
  模块均随后经 fresh 复审确认）。B3 开工前可由所有者选择补一轮 fresh 复审。
- **Design authority**: `design/cdd/notification-store.md`（79 AC）、`docs/architecture/data-model.md`、
  `docs/architecture/control-manifest.md`、ADR-0001/0002。

### 验证证据（Docker, golang:1.26.5, real PostgreSQL 18.4 via compose）

- `go vet ./...` clean;`go test -race ./...` 全绿：
  `internal/app` / `internal/config` / `internal/delivery` / `internal/notificationstore` /
  `internal/notificationstore/postgres` / `tests/integration` 全 ok。
- 测试规模：24 单元用例（transition 判别联合、domain 校验、cursor HMAC)+ 11 集成用例
  （迁移 up/down 幂等 + 10 个 Store 行为用例）。
- `go mod tidy` 无净变化（go.mod/go.sum 已固化）。

### 机械核验结果

| 检查 | 结果 |
|---|---|
| CTRL-024（无 Kafka/Redis/独立 DLQ/调度平台；无 lease 续约、无自动 dead 重放、无本地 fallback） | PASS（依赖仅 chi/pgx/migrate/client_golang；代码扫描零命中） |
| CTRL-016（pepper 值不进 Store/logs/metrics；仅 `pepper_id` 落库） | PASS（迁移仅 `pepper_id`；config fail-closed；`Pepper.String()` 只输出 ID 标签） |
| Outbox 语义（pending 行即 outbox、dead 行即 DLQ，无第二表；SKIP LOCKED claim；30s lease 上限；OCC） | PASS |
| Append-only（delivery_attempts 触发器 + 代码零 UPDATE/DELETE 路径） | PASS（触发器集成测试实证 UPDATE/DELETE 均报错） |
| B-01（cutoff 后 retryable actual result 当前写回原子 `die(deadline_exceeded)`、计数 +1、禁 next_attempt_at） | PASS（单元测试 `TestDecideTransition_Die_B01DeadlineExceededCountsAttempt`） |
| policy_termination 6 项不计数；error_code 矩阵（transport 必填/http 可选/unknown 可选/policy 空） | PASS（单元测试覆盖） |
| 防枚举（not-found 与越权统一） | PASS（`Transition`/`Get` 统一 not-found） |

### 评审中发现并修复的缺陷（实现期）

1. **迁移缺 3 列**(`updated_at`、`replay_actor`、`replay_reason`)——代码引用但 000001 未建；均有 CDD §data model 依据，补列。
2. **intake 冲突路径误判**——`ON CONFLICT DO NOTHING` 冲突时 pgx 返回 `ErrNoRows` 而非空 id；改为 `errors.Is(insertErr, pgx.ErrNoRows)` 走幂等矩阵。
3. **recovery `conn busy`**——pgx 单连接禁止交错查询；recovery 循环改为先物化行再逐行 UPDATE。
4. **scan NULL 崩溃**——可空列（lease/dead/replay/last_*）改指针扫描。
5. **cursor 参数类型歧义**——`listDeadSQL`/`listHistorySQL` 可空参数加显式 `::timestamptz`/`::uuid` cast。
6. **appendAttempt 违反 CHECK**——replay/recovery 的 `outcome_class`/`result_kind` 空串违反 CHECK，改 NULL。
7. **schema 漂移 `last_http_status`**——迁移与 domain 存在该列但**无 CDD 依据**（grep CDD 零命中）且代码从未读写；按 Authority Rule 移除（迁移 + domain 同步删除）。

### Reviewed artifact SHA-256

| Artifact | SHA-256 |
|---|---|
| `migrations/000001_create_base_tables.up.sql` | `acc48977f1b97de9657cd0a56bcbc56a7deaedee9c173104ee08f9c68b1257c8` |
| `internal/notificationstore/domain.go` | `0a1bc6ffd98ea5090098ddfb2f1b1d503c879477dcd4508d760e468e1e28140b` |
| `internal/notificationstore/transition.go` | `ec283a32a0498b25d4a88f7ba00982f7c29215d9ae4d5070c14adede56f27af4` |
| `internal/notificationstore/postgres/repository.go` | `56398ec785fe42588355af83fb028b4fedbe69ae2a7dfcb19ffc8fb7e2358e0a` |
| `internal/notificationstore/postgres/sql.go` | `0090c19e9e2b7e6bae42c2c9daabd57fba21120ac23630697e1d904aeeb0e8f5` |
| `internal/notificationstore/postgres/scan.go` | `4e145f6d18d5cb41b2f3113fc2d0ecdffdad99f92e306132692e3abd94e52792` |
| `internal/notificationstore/postgres/cursor.go` | `52c51cb030b65bebf28dfaf5e8f3d6745962b58613c6e98bafa17e9ce4e2265d` |
| `internal/config/config.go` | `aec4af9f38ff43c7254c85a5be56c6ade1bbc7e27495afee81d0aa40d0433cac` |
| `internal/app/server.go` | `4b87bb1657eb350c251024f51e395069f58018daa109e79542dcf57ce0e46d40` |
| `cmd/server/main.go` | `eff3d5c8e43357a1f21fbfeb10b71b84907f6c32074e2e5b63e375d647780456` |
| `tests/integration/notificationstore_test.go` | `35a2da6dd14f64b1cf104d77d338b742c5e68b8d53eb7c9710db08ce1247bb39` |
| `internal/notificationstore/transition_test.go` | `1d56cc8a09b0ff4441dd80e49a768dd4c2163bd4e6677666ad984779514f5625` |

### AC 覆盖估计（NS 79）

直接测试证据：intake 幂等矩阵（AC-IMM）、claim 资格/并发/排序（AC-LEASE 子集）、
OCC/lease-holder（AC-STATE 子集）、recovery（AC-LEASE recovery）、append-only（AC-ATT 子集）、
dead-list + replay + history（AC-DL/HIST 子集）、scoped outbox（AC 读模型子集）、
B-01 决策与 policy_termination/error_code 矩阵（AC 决策表子集）。
其余 AC（如 clock-unavailable、batch 边界全组合、cursor 漂移全矩阵、全局 vs scoped 全组合）为
code-only，建议 B6 端到端硬化时补齐对账；tr-registry 的 `planned_test_types` 对账同属 B6 范围。

### 通过标准对账（docs/development-plan.md）

- B1:CI 等价命令全绿 ✓；迁移 up/down 幂等 ✓；pepper fail-closed 有测试 ✓；无业务行为混入 ✓
- B2：判别联合单测 ✓；集成测试 `-race` 稳定 ✓；append-only 双重验证 ✓；
  独立评审——**非 pristine fresh-session，如实降级记录**（见 Method)；证据归档 ✓（本文件）
