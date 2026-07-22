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

## B3 Review — 2026-07-21 — Verdict: NEEDS REVISION

- **Scope**: B3 Caller Access + Vendor Registry 实现（domain、postgres adapter、HTTP composition、集成测试、迁移 000002/000003）。
- **Method**: 执行 CLAUDE.md 授权 Docker 命令（`go build ./... && go vet ./... && go test -race ./...`）+ CTRL-024/CTRL-016/Authority Rule/OpenAPI 机械核验。
- **Design authority**: `design/cdd/caller-access.md`、`design/cdd/vendor-registry.md`、`docs/architecture/control-manifest.md`、`docs/architecture/adr-0003-api-key-authorization.md`、`docs/api/openapi.yaml`。

### 验证证据（Docker, golang:1.26.5, real PostgreSQL 18.4 via compose）

- `go build ./...` clean; `go vet ./...` clean.
- `go test -race ./...` **失败**（并行包执行下 PostgreSQL deadlock）：
  - `internal/calleraccess/postgres`：`TestPostgresRepository_IssueKey_Concurrency` → `ERROR: deadlock detected (SQLSTATE 40P01)`
  - `tests/integration`：`TestCallerAccess_EndToEnd_RateLimit` → `clean caller access: ERROR: deadlock detected (SQLSTATE 40P01)`
- 同样命令加 `-p 1` 后**全绿**；确认是跨包并行时 `TRUNCATE TABLE access_keys, principals RESTART IDENTITY CASCADE` 与未提交事务互相等待，非 domain 逻辑缺陷，但 CI 等效命令（`.github/workflows/tests.yml` 未使用 `-p 1`）会失败。

### 机械核验结果

| 检查 | 结果 | 说明 |
|---|---|---|
| CTRL-024（无 Kafka/Redis/独立 DLQ/调度平台/service mesh；无 unbounded retry、lease renewal、自动 dead replay、本地 fallback） | PASS | 代码扫描零命中；依赖仍限于 chi/pgx/migrate/client_golang |
| CTRL-016（pepper 值不进 Store/logs/metrics/audit/responses；仅 `pepper_id` 落库） | PASS | `access_keys` 仅存 `pepper_id`；`Pepper.String()` 只输出 ID；logger 不记录 payload/secret；request logger 仅 method/path/status/duration/request_id |
| Authority Rule（每个 identifier 单一行为 authority） | PASS | Caller Access 包拥有 PrincipalRecord/AccessKeyRecord/AttenuatedContext；Vendor Registry 包拥有 VendorRecord/EndpointVersion/DeliveryConfigSnapshot/AdminCommand/AdminAuditEvent；postgres 子包仅实现各自父包 Repository；`internal/app` 仅作 composition |
| OpenAPI 公共端点契约 | **FAIL** | 多个 envelope 与 `docs/api/openapi.yaml` 不符（见下方） |
| YAML registries 解析 / AC 计数 | PASS | `tr-registry.yaml` 290 canonical AC + 4 NSBR boundary mappings；无重复 key |

### OpenAPI 契约不符（public endpoints）

1. **错误响应 envelope 结构错误**：handler 输出 `{"error":{"code":..., "message":..., "request_id":...}}`，但 OpenAPI `Error` schema 要求 `request_id` 在顶层、`error` 对象仅含 `code`/`message`。
2. **成功响应缺少 `data` wrapper**：handler 多数字符串直接返回字段（`result`、`items`、`vendor` 等），OpenAPI `SuccessEnvelope` 要求顶层 `request_id` + `data`。
3. **`/v1/notifications` 202 响应字段缺失/错误**：handler 返回 `{"notification_id", "idempotent", "request_id"}`，缺少 OpenAPI 要求的 `state`（const `pending`）和 `accepted_at`；字段名应为 `idempotent_replay`。
4. **Idempotency-Key 处理与 OpenAPI 矛盾**：OpenAPI 将 `Idempotency-Key` 标为 `required: true`，handler 在缺失时回退为 `request_id`，应返回 400。
5. **非契约错误码**：handler 返回 `INTERNAL_ERROR`（500），但 OpenAPI `ErrorDetail` enum 中未定义该码；`submitNotification` 也不允许 500 响应。

### 其他发现

- B3 迁移使用 `ADD COLUMN ... NOT NULL DEFAULT`，对已有空表或新部署无实际风险，但 `endpoint_versions.hostname` 默认空字符串对历史行可能语义不完整；建议后续迁移补正或限制在首次部署前应用。
- `access_keys.secret_hash` 上存在 `UNIQUE` 约束，可能引发极低概率哈希冲突导致的唯一键冲突；CDD 未明确授权该约束，但本次评审未列为阻塞项。

### Reviewed artifact SHA-256

| Artifact | SHA-256 |
|---|---|
| `internal/calleraccess/domain.go` | `ad0cbb0ef10291d8662436da22b4039d27e9b680592e1ecba2a2122f5c6ac4a5` |
| `internal/calleraccess/admin.go` | `0824903a3a96d4586cdc0707fec2485abd271d7eef0806b0d9bc9308af4d4433` |
| `internal/calleraccess/ratelimiter.go` | `b7a5c4d795018dcc7a5a8f416cf8a4cd7b09302e8e04108d11be2bf78dc8bce0` |
| `internal/calleraccess/postgres/repository.go` | `fcf0cd61d0c3de5aa6f6d1a5aca6e38b0d245f44c6b20e3a43e3d8212d0983bc` |
| `internal/vendorregistry/domain.go` | `e9f73314ddc460b0d50353a940844001d44031c56c0e07aa140357c741862cf6` |
| `internal/vendorregistry/service.go` | `a90cfefd280c5776703c6ae06807ab9b63dcf22ffc9bee0302cab52127698958` |
| `internal/vendorregistry/postgres/repository.go` | `745bacccbf8d750eeb725fb28e0fe3d1b9a9d8e96d7865538df2bcc62d807629` |
| `internal/app/server.go` | `9932ff8be8052b03a999500d2c196027c9743180fb1199abb8439b5243c7693f` |
| `internal/app/handlers.go` | `b8f54b80f2ad3675437d52dfe286bd85d68b553ff0c5a69d80fc5e407cde73ab` |
| `cmd/server/main.go` | `5302b4fb391c18958a16d34c6d3707ea7090b97a9081f39c34eeea63cf9a7223` |
| `migrations/000002_align_principals_b3.up.sql` | `99bcb6fa5e2abfb672a090ca167cbdb332de28f126b627e874bfe18a08dcca89` |
| `migrations/000003_b3_registry_fixes.up.sql` | `76877e05fdc247fb6813a76fab3d40da0dd10fd05023776bf49308f7676957e3` |
| `docs/api/openapi.yaml` | `1ab4b4cff43ee62e62186e192396fef7c1038651bfda51edcb16218c0921dca2` |

### 通过标准对账（docs/development-plan.md）

- B3：CI 等价命令 `go test -race ./...` **未全绿**（deadlock 在并行包执行下复现），需修正测试清理策略或 CI 并行度后方可重新评审。
- B3：CTRL-024/CTRL-016/Authority Rule 机械核验通过；OpenAPI 契约不符需修正后重新核验。

---

## B1–B4 Closure Self-Review — 2026-07-22 — Verdict: READY FOR INDEPENDENT REVIEW

- **Scope**: B1 工程/CI/迁移、B2 Notification Store、B3 Caller Access + Vendor Registry + HTTP
  composition、B4 Delivery transport/runner/worker，以及四批共享契约与测试证据。
- **Method**: 作者线程完成逐 finding 修正、CDD/OpenAPI/registry 机械对账、真实 PostgreSQL 18.4
  集成测试及 Go race 重复验收。
- **Independence limitation**: 本节不是 fresh-session independent review。按本项目既有纪律，同一
  执行线程不能签发正式 `APPROVED`；因此 B1–B4 只能进入 `READY FOR INDEPENDENT REVIEW`。
- **Supersedes for current implementation state**: 本节关闭上文 B2 `code-only`/B6 deferred 的
  覆盖估计以及 B3 的 OpenAPI/共享数据库测试 findings；保留旧记录作为历史，不改写原 verdict。

### 已关闭的契约与实现 finding

1. **B1/B2 并行数据库争用**：数据库测试改为每测试进程独立 schema，各自迁移、设置
   `search_path` 并清理；默认包并行不再依赖共享 `TRUNCATE` 或 `-p 1`。
2. **Store 证据债务**：补齐数据库时钟、rollback/commit outcome taxonomy、cursor
   篡改与 scope/operation、分页边界、global/scoped query、claim/lease/OCC、replay 竞态、
   不可变字段、整数边界、全部 result union、B-01 actual-result die 与非计数 policy termination。
3. **B3 public wire**：成功/失败统一 envelope；`Idempotency-Key` 必填并严格校验；202 返回
   `notification_id/state/accepted_at/idempotent_replay`；未知内部错误映射为登记过的
   `SERVICE_UNAVAILABLE`；全部 B3 路由以 OpenAPI request/response validator 验证。
4. **Vendor auth boundary**：MVP `auth_strategy` 收窄为 `bearer`；CDD、OpenAPI、entity registry、
   domain validator 与迁移约束同步；升级遇非 bearer 历史行显式失败，不静默转换。
5. **B4 transport**：禁 proxy/redirect，DNS 首次解析与连接前复核 fail closed，pin 已批准 IP
   并保留原 hostname TLS/SNI；拒绝非公网/保留/文档/benchmark/CGNAT/mapped 地址；不读取或
   drain 响应体；Resolver 与 dialer 可注入。
6. **B4 runner/worker**：B-01 保存临界 HTTP/transport 实际结果并在同一 Store 写回中 dead；
   未发送终止仍为非计数 policy termination；固定并发跨 tick 不扩张；shutdown 先停止新 claim，
   在有界 context 内等待在途 HTTP 与结果提交。

### 验证证据

环境：Docker `golang:1.26.5`；compose `postgres:18.4`；真实 PostgreSQL 集成测试使用独立 schema。

- `gofmt -w cmd internal tests` — PASS
- `go mod tidy` — PASS；`go.mod` / `go.sum` 已落盘
- `go build ./...` — PASS
- `go vet ./...` — PASS
- `go test -race ./...` — PASS
- `go test -race ./... -count=5` — PASS（含 `tests/contracts` 79.899s、
  `tests/integration` 13.689s；未使用 `-p 1`）
- AC evidence contract — PASS：NS 79 + CA 15 + VR 152 + DL 20 = **266**；无缺失、重复、
  空证据、`code-only` 或 `deferred`；所引用测试函数均存在。
- OpenAPI request/response validation — PASS：B3 全部路由及平台端点。
- Migration — PASS：fresh install、逐步 down/up、bearer-only 与 attempt result union 直接插入约束。

### Reviewed artifact SHA-256

| Artifact | SHA-256 |
|---|---|
| `internal/app/handlers.go` | `d91aa646d8dbdd3a0f1563546b59e1166ddcf4f45faa70074da92292ca5282ca` |
| `internal/app/server.go` | `d1d93d52efdabd5d42d9b01c280fb92bae051987588ce00cccc5d1b65676b05b` |
| `internal/notificationstore/postgres/repository.go` | `b1888e9732ebec0f6c4800156803f9975e196aef508a63a9d13f5ef4ef636def` |
| `internal/vendorregistry/domain.go` | `fb01deb221965d5dce7c5a4575c5c41a5548e279c86c965fa721ab17e83625a0` |
| `internal/delivery/runner.go` | `b470911440af17c70c6a6d1ef31ee616d556bfb46b0d50306ebf507cc3a58593` |
| `internal/delivery/transport.go` | `c85c04e5758f816f4f427f5d558f06215c222e058cb92eef754942ffb33021fc` |
| `internal/delivery/worker.go` | `7b1484f68177b20b49061c8ea0e9b8e63842d8956e1d5597462ecf00914bd8b2` |
| `migrations/000003_b3_registry_fixes.up.sql` | `bb8eb311e2474801ada04ef3256cdc5d65e3436bb44bdf414d6599458f207361` |
| `migrations/000004_b4_delivery_result_contract.up.sql` | `f3f7e406bbd6927a076975fab8e441c25b0680db3c2e47f6deec6a4b48755a27` |
| `docs/api/openapi.yaml` | `75144895acce61946161d24d2f47e73cb7f75b7816127d12f373325e95c54133` |
| `docs/testing/b1-b4-ac-evidence.json` | `e6f81b95003e255c358e72b03a4f65584adbdb8f5928523e87e952582b8dc8ee` |
| `tests/contracts/ac_evidence_test.go` | `fed8dbf97eea49a3b2681469350120bcdcb95595fee43fd78b1d05b604796b6a` |
| `tests/integration/delivery_test.go` | `8c8535a4b79e7619003196f55ec43b1e8bc52e7b79a75801d67c31407e7bb190` |

### Remaining gate

唯一剩余的 B1–B4 正式验收项是 fresh independent review：分别确认 B1/B2 closure、B3 re-review、
B4 review，再做 cross-batch review。独立 reviewer 未签发前，README、development plan、T0 state
均不得报告 B1–B4 `APPROVED`。B5/B6 不在本轮范围，尚未开始。

---

## B1–B4 Closure Self-Review Addendum — 2026-07-22

**Verdict: READY FOR INDEPENDENT REVIEW（executor self-review；不是 independent APPROVED）**

本追加轮在前一自审之后关闭了以下契约缺口，旧记录与旧 SHA 保留为历史：

1. Vendor Registry 对 canonical URL/FQDN、HeaderRule、outbound-idempotency mapping、private CIDR
   exception 和启动配置执行闭合校验；cursor 改为 operation/scope/limit/snapshot 绑定的 HMAC envelope。
2. 授权后的七类业务拒绝恰写一条无 receipt 的 rejected audit；允许已授权
   `VENDOR_NOT_FOUND` 使用无 VendorRecord 的不可变目标 ID；成功/拒绝联合由 `000006` 数据库约束固化。
3. OpenAPI scope filter 改为三个可机械验证的闭合 bracket-name 参数，handler 仍执行 discriminator
   联合与 scope attenuation；所有 B3 请求/响应继续通过 OpenAPI validator。
4. Delivery 增补 DNS 二次失败、proxy 环境、timeout、request/header injection、危险地址例外、
   cutoff/attempt 优先级、health signal 与 shutdown 等负向/并发证据。
5. AC evidence schema v2 在文件内显式登记 266 个 AC；契约测试逐项核对 canonical registry、CDD
   文本、唯一 family、非 deferred evidence type 以及真实测试函数。
6. 迁移矩阵实测 clean install、从 `000001` 升级、既存非 bearer 行升级失败、`000006` 单步
   down/up、完整 down/up，以及 bearer / delivery-attempt / admin-audit 联合的直接插入约束。

### Mechanical acceptance rerun

- Docker `golang:1.26.5` + PostgreSQL `18.4`
- `gofmt -w cmd internal tests` — PASS
- `go mod tidy`、`go build ./...`、`go vet ./...` — PASS
- `go test -race ./...` — PASS
- `go test -race ./... -count=5` — PASS（`tests/contracts` 77.824s；
  `tests/integration` 15.108s；默认包并行，未使用 `-p 1`）
- AC evidence — PASS：NS 79 + CA 15 + VR 152 + DL 20 = 266 个显式、唯一、可追踪 AC
- OpenAPI request/response contract、JSON/YAML registry parse、migration matrix — PASS

### Addendum artifact SHA-256

| Artifact | SHA-256 |
|---|---|
| `internal/app/handlers.go` | `d98ee22ac8b0a8cbc8886b1253fb55bb145c097b891ec67fc338c1bab1dfa0d8` |
| `internal/calleraccess/domain.go` | `bee3ecef42a334d0eda6df6843946feb27e91bd445d9a2ca4735dd1e28cd59eb` |
| `internal/notificationstore/postgres/repository.go` | `b1888e9732ebec0f6c4800156803f9975e196aef508a63a9d13f5ef4ef636def` |
| `internal/vendorregistry/domain.go` | `60326fa3d168f75d058940b73428937ea459465c4d09836c4ad0bc638d75db67` |
| `internal/vendorregistry/service.go` | `54c0ba9cfbfccd0873d724218f7423580fcec6a2527de69dab999b9281abaa57` |
| `internal/vendorregistry/postgres/repository.go` | `ca5f49055d17d95edad58731581e331dee115aac4b1a12f0521dab4fa0e31098` |
| `internal/delivery/requestbuilder.go` | `9b23d6f5ec88470d3654a2b3e67e0ffd529d5e846b8cb32eb6057edf3baa00f9` |
| `internal/delivery/runner.go` | `7f7ecfdd054b80611576f28b7af51d8ae627f81cee14b71f65d0d6ec8c48ed7a` |
| `internal/delivery/transport.go` | `3f0882b0199b499ad23022306a0ca9afb4e59dc078620c24e095f19044448e74` |
| `internal/delivery/worker.go` | `067181ca49817c35d55a9d2c9aa8d19b4a3992b3060c81a7de4036cfe58b813e` |
| `migrations/000005_vendor_rejected_audit_targets.up.sql` | `589c7227f8ae8163a17f8c19815f579b002bb0d214c83d68be721fa507a17f57` |
| `migrations/000006_vendor_audit_union.up.sql` | `2b8223b6292090a3df2b78904b1116d0cc3f3f4c21c48eb814f728ec0a11342a` |
| `docs/api/openapi.yaml` | `4aadbb2a87853991e248a40ae3286c169d84c37e9d5265e51405156ffd46b3ff` |
| `docs/testing/b1-b4-ac-evidence.json` | `30c1c03b0624fe3dacb9e8e888e7096f7d914d8d16ee35cc03c0d8461e77d099` |
| `tests/contracts/ac_evidence_test.go` | `21774b7df50a90e8d1383320e85e72a574916cca13072f3c5dbae54c71b88ab7` |
| `tests/integration/migration_test.go` | `cb61a26fc8df50964882338503f2bd47c4c7f8a694536821dce1496a1e4a3d73` |

### Remaining gate

实现者不能签发 fresh independent verdict。B1/B2 closure、B3 re-review、B4 review 与最终
cross-batch review 仍须由独立 reviewer 执行；在该历史快照时点，四批保持
`READY FOR INDEPENDENT REVIEW`，B5/B6 尚不在已授权范围且没有实现；后续授权、实现与 review
结论见下方 B5/B6 记录。

---

## B1 + B2 Fresh Independent Closure Review — 2026-07-22

**Verdict: APPROVED**

- Review mode：fresh independent、read-only。
- Reviewed workspace manifest：107 entries；SHA-256
  `08c6bae9016f3adcd3edc8c648bd1c30012f721bd2f771cd7c7e45d10a1e0d37`。
- 范围：工程基线、PostgreSQL migration、Notification Store 79 AC、每测试独立 schema、并发
  claim/lease/OCC、commit taxonomy、cursor/scope、全部 result union 与 B-01 Store 写回。
- Blocking findings：0。

## B3 Fresh Independent Re-Review — 2026-07-22

**Verdict: APPROVED**

- Review mode：fresh independent、read-only。
- Reviewed workspace manifest：同上 `08c6bae9…e0d37`。
- 范围：Caller Access 15 AC、Vendor Registry 152 AC、统一 envelope、严格 JSON、OpenAPI 全路由、
  bearer-only migration、权限/轮换/审计/cursor/config snapshot。
- Blocking findings：0。

## B4 Fresh Independent Review — 2026-07-22

**Verdict: APPROVED**

- Review mode：fresh independent、read-only。
- Reviewed workspace manifest：同上 `08c6bae9…e0d37`。
- 范围：Delivery 20 AC、SSRF transport、request builder、runner/worker、DNS rebinding、B-01、
  Retry-After、shutdown 与真实 PostgreSQL integration。
- Blocking findings：0。
- 后续新增的真实 PostgreSQL `N=W`、vendor-disable-after-send、Retry-After preservation 等 Delivery
  delta 由 B6 review 与最终 cross-batch review 覆盖，不追写旧 verdict 的 artifact 范围。

## B5 Fresh Independent Review — 2026-07-22

**Verdict: APPROVED（0 blocking / 0 non-blocking）**

- Review mode：fresh independent、read-only；首轮 `NEEDS REVISION` 后执行有边界修正并重新冻结。
- Final reviewed manifest：161 entries；SHA-256
  `277b02524d13e99b5fcfb1207a42a2492ee349bc08fe4bf95032d233f020c247`；
  `sha256sum -c` 161/161 PASS。
- 已闭合首轮 findings：六路由逐请求认证与 revoked zero-downstream；OC capability/scope 完整拒绝矩阵；
  real-PG preview→concurrent replay→stale execute 非破坏；pagination 参数/顺序/cursor；runtime marker；
  RO missing `read_all_notifications` → forbidden/zero projection → `/metrics` 503/no business sample。
- Operations Control、Reliability Observability、OpenAPI、闭合投影、权限衰减与 Prometheus 状态语义
  均未发现残余 blocker。

## B6 Fresh Independent Review — 2026-07-22

**Verdict: APPROVED（0 blocking / 0 non-blocking）**

- Review mode：fresh independent、read-only；首轮 `NEEDS REVISION` 后执行有边界修正并重新冻结。
- Final reviewed manifest：同上 `277b0252…c247`；161/161 checksum PASS。
- 已闭合首轮 findings：PITR 使用真实 fixture 并验证 notification/vendor version/audit+receipt/
  access-key/attempt append-only；real-PG Runner `N=W=5` deadline；table/index before/after/growth；
  duplicate active/previous pepper ID fail-closed；PITR source temp cleanup。
- Lease recovery、pepper rotation/revocation、Compose/Prometheus、crash-after-send、DB restart、bounded
  shutdown、capacity、marker scan 与 no-SLA posture 均未发现残余 blocker。

## B1–B6 Batch Review Correction and Final Closure — 2026-07-22

**Verdict: APPROVED（逐批结论；最终 cross-batch closure 仍须另行签发）**

本节不删除或改写此前评审历史。此前 B4、B5、B6 小节中的 “final” 仅代表当时冻结清单；后续
独立审查又发现了新的 blocking finding，因此这些标签由本节记录的完整修正链取代：

- **B1 + B2**：在后续实现增量完成后，以 `7e5d13…` 清单执行 fresh regression review，结论
  `APPROVED`，0 blocker。
- **B3**：以同一 `7e5d13…` 清单执行 fresh re-review，覆盖 nullable
  `credential_ref_version` 读取回归、迁移矩阵、Caller Access 15 AC、Vendor Registry 152 AC 和
  OpenAPI wire contract，结论 `APPROVED`，0 blocker。
- **B4**：`7e5d13…` 复审发现 408/5xx 未保留 `Retry-After` 且 DL-05 缺直接证据，结论
  `NEEDS REVISION`；`277b025…` 再审发现超大 delta-seconds 可发生 duration overflow，仍为
  `NEEDS REVISION`；加入显式上界检查、fallback 与真实 PostgreSQL 回归后，在
  `69bdf250d3bbfc76e8df679c3524068c3604fbf54668817e61f2c3c5c25e90f2` 清单上
  `APPROVED`，0 blocker。
- **B5**：首轮发现 Operations capability/scope 与 Reliability evidence 缺口；`277b025…`
  再审发现 403 OpenAPI 测试可错误地以 401 分支通过。补齐真实 400/401/403/404/429/503
  状态断言后，在 `69bdf250…e90f2` 清单上 `APPROVED`，0 blocker。
- **B6**：首轮发现 PITR fixture、真实 PostgreSQL `N=W`、relation growth 与 duplicate pepper
  ID 缺口；`277b025…` 再审发现数据库停机演练没有证明同一通知恢复后的 claim/outcome 闭环。
  修正演练并重新生成机器证据后，在 `69bdf250…e90f2` 清单上 `APPROVED`，0 blocker。

最终逐批冻结清单共 161 entries，`sha256sum -c` 161/161 PASS。机械验收包括
`go build ./...`、`go vet ./...`、`go test -race ./...`、`go test -race ./... -count=5`、
Prometheus config/rules/unit tests、Compose health、fault/capacity/PITR/pepper/marker drills；
AC evidence 为 290/290 canonical AC + 4/4 NSBR。逐批 `APPROVED` 不能替代最终跨批次审查。

## B1–B6 Cross-Batch Closure Attempt 1 — 2026-07-22

**Verdict: NEEDS REVISION**

- Review mode：fresh independent、read-only。
- 程序性 blocker：评审期间 8 个文件发生合法的验收补强，导致原 161-entry manifest
  `9ce25bf40764801efc31eb83be863412ae4d7e0395fd18a634db74d7d2a91f28` 漂移；reviewer 拒绝对
  失效清单签发 Approved。
- 实质审查未发现新增代码、公开契约、安全或可靠性 blocker。
- Non-blocking：容量报告的 drain rate 只覆盖 PostgreSQL claim + result commit transactional path，
  已明确不是包含 Runner、DNS 与供应商 HTTP latency 的端到端吞吐，也不是 SLA。
- 修正：补齐 Retry-After overflow、OpenAPI/Operations 负向证据、数据库停机后同进程恢复处理断言，
  重新执行 fault drill、marker scan、build/vet/race/race×5、Prometheus 与 Compose 验收，并等待新清单
  的 fresh re-review。

## B1–B6 Cross-Batch Closure Final Review — 2026-07-22

**Verdict: APPROVED（0 blocking / 1 disclosed non-blocking limit）**

- Review mode：fresh independent、read-only。
- Reviewed manifest：161 entries；manifest SHA-256
  `c1edbcf133262f3997cabe4c785f36afe37a637a4cd5c60aa3d6ad2822ff1256`；
  `sha256sum -c` 161/161 PASS。
- 首轮 manifest drift blocker 已关闭；Retry-After overflow、B-01 actual-result、OpenAPI error branches、
  Operations re-auth/capability/scope、crash-after-send、数据库恢复后继续处理、lease recovery 与有界关闭
  均经复验。
- 290/290 canonical AC + 4/4 NSBR、Prometheus rule tests、PITR、pepper rotation、marker scan 与部署
  边界均有真实证据；阶段保持 `Implementation`，GitHub CI 保持 `NOT_RUN`，不声明 RPO/RTO。
- Non-blocking：capacity drain 仅为 PostgreSQL claim/result-commit transactional path 本机基线，不是
  含 Runner/DNS/vendor HTTP latency 的端到端吞吐或 SLA；报告已明确披露。

结论：B1–B6 及完整跨批次闭包 Approved，本地状态可写为 submission-ready。

## B1–B6 Cross-Batch Final Review Correction — 2026-07-22

**Verdict: NEEDS REVISION（supersedes the preceding final label）**

对同一 `c1edbcf…1256` 清单执行的后续 fresh read-only audit 发现三项 truth/correctness blocker，
因此上一节不能继续作为当前 final verdict：

1. `design/accessibility-requirements.md` 仍标 Draft/pending gate，而 T1 accessibility 镜像又声称该
   文件不存在；已统一为 sensory/UI N/A + implemented Basic API ergonomics，并保留历史 gate 未运行。
2. `tests/README.md`、`internal/delivery/backoff.go` 与 `standards/technical-preferences.md` 仍以现在时
   声称 authored-but-not-compiled、无 dependency manifest 或 implementation 尚未开始；已更新为本地
   Go 1.26.5/PostgreSQL 18.4 实证，GitHub Actions 仍明确 `NOT_RUN`。
3. Store `QueryOutbox` 把负 `oldest_pending_age_seconds` clamp 为 0，使 Reliability 无法按契约对负投影
   fail closed；已移除 clamp，并增加真实 PostgreSQL future-created-at 回归，确认 collector 返回空
   snapshot + error，HTTP 组合层继续映射 503 且不发布业务样本。

受影响的 targeted race tests 已通过。修正后的工作区须重新执行全量机械验收、冻结新 manifest 并由
fresh reviewer 签发；在此之前状态保持 `Implementation`，不得写为 submission-ready。

## B1–B6 Cross-Batch Re-Review Attempt 3 — 2026-07-22

**Verdict: NEEDS REVISION（truth-surface only）**

- Reviewed manifest：161 entries；SHA-256
  `24754678f056d1893d8f758a3f756ee53b7369678f8c3467ca8229857e3ccfc2`；161/161 PASS。
- 290 canonical AC + 4 NSBR、JSON/YAML/Compose 与上一轮三项修正均通过独立核验。
- Blocking drift：根 `CLAUDE.md` 仍把当前范围写为 B1/B2、B3+ 未授权、`/healthz`、
  `client_golang` 和 Architecture stage；T2 workflow contract 仍镜像 Architecture；T0 next command
  仍要求重复已经完成的验收/冻结步骤。
- Correction：上述活动 truth surface 已统一为 Implementation、B1–B6 implemented/batch-approved、
  `/health/live|ready|metrics`、直接 Prometheus text exposition，并保留历史 gate 未运行和 final re-review
  pending。`.gocache/` 同步加入 ignore，避免 422MB 本机构建缓存污染提交面。

本轮没有修改 public API、领域行为、迁移或已通过的运行演练；新清单仍须 fresh read-only re-review。

## B1–B6 Cross-Batch Closure Final Re-Review — 2026-07-22

**Verdict: APPROVED（0 blocking / 0 new non-blocking）**

- Review mode：fresh independent、read-only；reviewer 未修改文件或容器状态。
- Reviewed manifest：161 entries；SHA-256
  `04dba3bcb23d1684397c0c45d2b5afb896fb6dda10a45ec38bb884e82a1b8cca`；最终复核
  `sha256sum -c` 161/161 PASS。
- 前两轮 correctness/truth blockers 与 attempt 3 的 CLAUDE/T2/T0 漂移全部关闭。
- 290/290 canonical AC + 4/4 NSBR 唯一；1,324 条 evidence test reference 全部指向存在的测试；
  Markdown relative links 46/46、YAML unique-key parse、JSON、Compose config 与 OpenAPI 3.1 的 15 条
  API/platform path 均 PASS。
- 静态抽查重新确认 negative-age fail-closed、B-01/Retry-After、SSRF/DNS/TLS/proxy、operator replay、
  exact-three metrics、lease recovery 与 pepper generation 证据。
- Existing disclosed limit：capacity drain 仅为 PostgreSQL claim/result-commit transactional-path 本机基线，
  不是端到端 vendor HTTP throughput 或 SLA；不是新 finding。
- External boundary：GitHub Actions `NOT_RUN`；production deployment `NOT_IN_SCOPE`；无 RPO/RTO 声明；
  Architecture→Pre-Implementation gate 仍明确未运行。

结论：B1–B6 complete implementation corpus Approved，可把本地状态同步为 submission-ready；阶段保持
`Implementation`。

---
