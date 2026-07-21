# Current State — T0 Core

> 镜像 `../../production/stage.txt`。当前阶段、阻塞项、下一步。

## Snapshot
- **Domain**: product（通用产品项目）
- **Current phase**: Implementation（owner authorized 2026-07-21；B1 + B2 completed and verified, B3 not authorized）
- **Stage source**: `../../production/stage.txt` = `Implementation`
- **Review mode**: lean（最近模块评审使用 `--depth lean`；repo 级 `review-mode.txt` 未建）
- **Strict QA mode**: off
- **Last completed gate**: PASS（Specification → Architecture, run 03, 2026-07-20）—
  `../t3_archive/gate-archive.md` Run 4
- **Last updated**: 2026-07-21

## Current Blocker
- **Blocker**: none；B1 + B2 completed and verified (`go vet` + `go test -race` green on real PostgreSQL 18.4 via Docker).
- **Next command**: await owner authorization for B3 (Caller Access + Vendor Registry).
- **Evidence required**: B3 fresh-session review per `docs/development-plan.md`.

## State Evidence（里程碑；逐轮评审明细见 `../../design/cdd/reviews/review-archive.md`）
| 日期 | 事件 | 产物 / 证据 |
|---|---|---|
| 2026-07-18 | T0 宪法 v1.0 Accepted 签发（BL-01..06；草案审查 + 用户核验 rev 2） | `basic_law_index.md`、`../t3_archive/amendments/amendment-v1.0-2026-07-18.md`、`../t3_archive/reviews/review-index.md`（附录） |
| 2026-07-18 | product-concept design-review 独立复审 APPROVED；Concept → Specification gate PASS，阶段推进 | `../../design/cdd/reviews/review-archive.md` §product-concept、`../t3_archive/gate-archive.md` Run 1 |
| 2026-07-18 | module-index Approved（6 modules / 5 edges / DAG） | `../../design/cdd/module-index.md` |
| 2026-07-18 | Notification Store CDD 经 4 轮 independent re-review APPROVED（79 AC；15 blockers 逐轮闭合） | `../../design/cdd/notification-store.md`、`../../design/cdd/reviews/review-archive.md` §Notification Store |
| 2026-07-19–20 | Vendor Registry CDD 经 5 轮 re-review（E–J 批次 bounded revision；用户裁决 J1–J3）APPROVED（152 AC） | `../../design/cdd/vendor-registry.md`、`../../design/cdd/reviews/review-archive.md` §Vendor Registry |
| 2026-07-20 | Caller / Delivery / Operations / Observability 四份 concise CDD 起草、复审；Caller APPROVED，其余经 limited-exception 修订 | `../../design/cdd/reviews/review-archive.md` 各模块节 |
| 2026-07-20 | cross-review run 01 FAIL（1/6）→ run 02 FAIL（5/6，B-01 存活）；gate run 01/02 FAIL，阶段未推进 | `../../design/cdd/reviews/review-archive.md` §Cross-CDD、`../t3_archive/gate-archive.md` Run 2/3 |
| 2026-07-20 | 用户裁决 B-01：临界 retryable attempt 在当前结果写回原子 `die(deadline_exceeded)`；Delivery APPROVED（20 AC） | `../../design/cdd/reviews/delivery-deadline-adjudication.md`、`../../design/cdd/reviews/review-archive.md` §Delivery |
| 2026-07-20 | consistency-check + cross-review run 03 PASS（290/290 AC + 4/4 NSBR；entity registry 建立）；gate run 03 PASS，阶段推进 Architecture | `../../design/cdd/reviews/review-archive.md` §Cross-CDD run 03、`../t3_archive/gate-archive.md` Run 4 |
| 2026-07-20 | Architecture package fresh independent review APPROVED；4 项 advisory 全部在 Architecture 范围闭合（pepper 生命周期、deadline backlog、entities.yaml 注册、SHA 基线） | `../../docs/architecture/architecture-review-archive.md`、`../../design/cdd/reviews/deadline-backlog-pressure-analysis-2026-07-20.md` |
| 2026-07-21 | Owner authorized entering Pre-Implementation (CP0)：Test Framework Baseline 骨架（`go.mod` majors-only、backoff leaf + 单测、`tests/`、CI、`design/accessibility-requirements.md`）；authored-but-not-compiled，编译验证交由 CI；gate 未运行，stage 仍 Architecture | `../../go.mod`、`../../internal/delivery/`、`../../tests/README.md`、`../../.github/workflows/tests.yml` |
| 2026-07-21 | Owner-authorized 文档 consolidation：13 份 review log/cross-review → `review-archive.md`；2 份 architecture review → `architecture-review-archive.md`；4 份 gate run → `gate-archive.md`；constitution review 并入 review-index 附录；删除占位文件（release_state、session-state、architecture/README）；镜像规则四改三 | 各档案头部 consolidation 注记、`amendment_log.md` |
| 2026-07-21 | 分批次开发计划建立：CP0 → B1 工程基座 → B2 Store → B3 Caller+VR → B4 Delivery → B5 OC+RO → B6 硬化/部署；每批含范围冻结、5 步审查流程与通过标准；不授权任何代码 | `../../docs/development-plan.md` |
| 2026-07-21 | 所有者授权进入 Implementation；stage.txt → `Implementation`。B1 工程基座交付：`go.sum` 固化（chi v5.2.0 / pgx v5.7.1 / migrate v4.18.1 / client_golang v1.20.5）、`migrations/000001` 基础 schema（5 张逻辑表 + append-only trigger + OCC/lease 列；无独立 outbox 表）、`internal/config`（env allowlist + fail-closed pepper）、`internal/app`（`/healthz` + `/metrics` + 优雅关闭）、`cmd/server`、Dockerfile/docker-compose。B2 Notification Store 核心实现中：`internal/notificationstore` domain + transition + PostgreSQL repository 已写入，尚未接 HTTP、无本包测试、未独立评审 | `../../migrations/`、`../../internal/config/`、`../../internal/app/`、`../../internal/notificationstore/`、`../../Dockerfile`、`../../docs/ai-usage.md` §B1 |
| 2026-07-21 | B1 + B2 完成并验证：B2 Store 全量落地（domain/状态机/postgres adapter）+ 21 单元 + 10 真实 PostgreSQL 集成用例（幂等/并发 claim/lease-holder/crash-after-send/append-only/dead-list+replay/scoped outbox），`go vet` + `go test -race` 全绿；修复 7 处缺陷（含无 CDD 依据的 `last_http_status` 列按 Authority Rule 移除）；启动迁移接线；评审归档（非 pristine fresh-session，如实记录） | `../t3_archive/reviews/implementation-review-archive.md`、`../../docs/ai-usage.md` §B2 |
