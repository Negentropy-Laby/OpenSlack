# Current State — T0 Core

> **Imported historical record.**
>
> Imported history is retained for provenance.
> It is not the current OpenSlack roadmap, module status, runtime admission,
> release authority, or production-readiness source.

> 镜像 `../../production/stage.txt`。当前阶段、阻塞项、下一步。

## Snapshot
- **Domain**: product（通用产品项目）
- **Current phase**: Implementation（B1–B6 implemented, mechanically verified, independently Approved and local submission-ready）
- **Stage source**: `../../production/stage.txt` = `Implementation`
- **Review mode**: lean（最近模块评审使用 `--depth lean`；repo 级 `review-mode.txt` 未建）
- **Strict QA mode**: off
- **Last completed gate**: PASS（Specification → Architecture, run 03, 2026-07-20）—
  `../t3_archive/gate-archive.md` Run 4
- **Last updated**: 2026-07-22

## Current Blocker
- **Blocker**: 本地 submission readiness 无 blocker。GitHub-hosted CI 与生产部署尚未运行，且不在
  本轮授权范围内。
- **Next command**: 若所有者另行授权，再执行 commit/push 或 GitHub-hosted CI；不得把未运行的外部
  证据写成已完成。
- **Evidence available**: 290 AC + 4 NSBR 机器映射、OpenAPI、真实 PostgreSQL 18.4、Prometheus、
  Compose、fault/capacity/PITR/pepper 演练；最终 race ×5 已复跑通过。

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
| 2026-07-21 | 所有者授权进入 Implementation；stage.txt → `Implementation`。B1 初始工程基座交付：`go.sum`、基础 schema、config、早期 HTTP 健康占位、`cmd/server` 与 Docker。B2 初始切片只有 Store domain/transition/PostgreSQL repository，尚无 HTTP/本包测试/独立评审；该历史状态已由 2026-07-22 B1–B4 closure 事件 supersede | `../../migrations/`、`../../internal/config/`、`../../internal/app/`、`../../internal/notificationstore/`、`../../Dockerfile`、`../../docs/ai-usage.md` §B1 |
| 2026-07-21 | B1 + B2 完成并验证：B2 Store 全量落地（domain/状态机/postgres adapter）+ 21 单元 + 10 真实 PostgreSQL 集成用例（幂等/并发 claim/lease-holder/crash-after-send/append-only/dead-list+replay/scoped outbox），`go vet` + `go test -race` 全绿；修复 7 处缺陷（含无 CDD 依据的 `last_http_status` 列按 Authority Rule 移除）；启动迁移接线；评审归档（非 pristine fresh-session，如实记录） | `../t3_archive/reviews/implementation-review-archive.md`、`../../docs/ai-usage.md` §B2 |
| 2026-07-22 | B1–B4 closure：bearer-only 契约与迁移约束、Store 验收债务、B3 envelope/OpenAPI、B4 SSRF-safe transport/runner/worker 全部闭合；每测试独立 PostgreSQL schema 消除默认并行死锁；NS 79 + CA 15 + VR 152 + DL 20 = 266 项 AC 证据映射通过；`build`、`vet`、全量 race 及 race ×5 全绿。当前自审结论为 READY FOR INDEPENDENT REVIEW，不冒充正式 Approved | `../../docs/testing/ac-evidence.json`（现已扩展为 B1–B6）、`../../tests/contracts/ac_evidence_test.go`、`../t3_archive/reviews/implementation-review-archive.md` §B1–B4 Closure Self-Review、`../../docs/ai-usage.md` §B1–B4 Closure |
| 2026-07-22 | B1–B4 closure addendum：266 个 AC 改为文件内逐项显式登记；补 VR audit/cursor/config 联合、Delivery proxy/timeout/shutdown 等对抗测试；迁移矩阵扩展到 v1 upgrade、non-bearer fail-closed、单步及完整 down/up；全量 build/vet/race/race×5 复跑全绿。状态仍为 READY FOR INDEPENDENT REVIEW | `../t3_archive/reviews/implementation-review-archive.md` §B1–B4 Closure Self-Review Addendum、`../../docs/testing/ac-evidence.json`（现已扩展为 B1–B6） |
| 2026-07-22 | B5–B6 实现与全量机械验收：Operations/RO、单快照 metrics、Prometheus rule test、lease recovery advisory lock、pepper fail-closed、production image/Compose；crash-after-send、DB restart、deadline matrix、1,100 条容量基线、age 加密 PITR 均形成真实证据。290 AC + 4 NSBR 映射通过；状态保持 READY FOR INDEPENDENT REVIEW | `../../docs/testing/ac-evidence.json`、`../../docs/testing/acceptance-report.json`、`../../docs/testing/capacity-report.md` |
| 2026-07-22 | B1/B2、B3、B4、B5、B6 fresh independent review 全部 Approved；B5/B6 首轮 findings（PITR fixture、真实 PG N=W、relation growth、OC capability/scope、RO-04 evidence、duplicate pepper ID）经修正和全量复验闭合；最终 cross-batch review Approved，0 blocker，本地状态冻结为 submission-ready | `../t3_archive/reviews/implementation-review-archive.md`、`../../docs/testing/workspace-manifest.sha256` |
| 2026-07-22 | 后续独立 audit 使上一行的 final 标签失效：发现 accessibility/CP0/technical baseline 旧时态矛盾，以及 Store clamp 负 oldest age 会绕过 RO fail-closed；修正已完成，最终状态退回等待 re-review | `../t3_archive/reviews/implementation-review-archive.md` §Cross-Batch Final Review Correction、`../../tests/integration/operations_observability_test.go` |
| 2026-07-22 | 第三次 re-review 又发现 CLAUDE/T2/T0 活动 truth-surface 漂移；有界修正后，最终 fresh read-only review 对 161 文件清单签发 APPROVED，0 blocker / 0 新 non-blocking；本地状态冻结为 submission-ready | `../t3_archive/reviews/implementation-review-archive.md` §B1–B6 Cross-Batch Closure Final Re-Review、`../../docs/testing/workspace-manifest.sha256` |
