# Gate Run Archive — T3 Archive

> **2026-07-21 owner-authorized consolidation**：本档案合并并取代退役原件
> `gate_runs/gate-specification-2026-07-18.md`、`gate_runs/gate-architecture-2026-07-20.md`、
> `gate_runs/gate-architecture-2026-07-20-02.md`、`gate_runs/gate-architecture-2026-07-20-03.md`。
> 原件已删除；各 run 的检查项 verdict、证据与 SHA-256 压缩保存于本档案。
> 所有 run 均为手动执行 CDD gate 方法论（`--review lean`）；governing catalog SHA
> `380a881a094184b4d2eb5cdfe59154bc82532147615466adbe2e8a30f1fdc78d`。

## Run 1 — Concept → Specification — 2026-07-18 — PASS（Advanced）

- **Required artifacts 3/3 PASS**：宪法 v1.0 Accepted（BL-01..06）；`design/cdd/product-concept.md` 齐备；
  Concept Review APPROVED（Batch B 独立复审；见 `../reviews/review-index.md` 与
  `design/cdd/reviews/review-archive.md`）。
- **Quality checks 4/4 PASS**（最新 verdict 非 MAJOR REVISION、user journey、persona/JTBD、core thesis）。
- **Director Panel**：CD / TD / PR 均 READY；AD SKIPPED（headless 服务无视觉交付物）。
- **Carry-forward risks（非阻塞）**：CD — BL-05 边界侵蚀压力；TD — SSRF 实现复杂度 High、API Key 为 MVP
  唯一防线；PR — SSRF 密度为最可能拖延处，算法归属 SSRF ADR。
- **CoV 5 问存活**；用户双批准后 stage.txt 建为 `Specification`。
- **Post-gate 文档级修订**：review-index 证据路径修正；SSRF 责任澄清（行为契约 vs ADR 算法）。
- **Pre-gate SHA 基线（Phase 0 原样捕获）**：product-concept `00feabd8…`、
  product-concept-review-log `ba46a58d…`、active_context `5a9878ea…`、amendment_log `2e00d212…`、
  basic_law_index `c6ead619…`、current_state `4db1f91e…`、release_state `c26c962f…`、
  amendment-v1.0 `c9389b8f…`、constitution-draft review `a5bad7c4…`、review-index `89953836…`。

## Run 2 — Specification → Architecture — 2026-07-20 — FAIL（Not advanced）

- **Required artifacts**：Systems Map PASS；MVP CDDs Approved **FAIL**（1/6）；per-system review **FAIL**；
  cross-review **FAIL**（run 01 cross-review verdict FAIL）。
- **Quality/risk**：四份 concise CDD budget PASS；T0 覆盖 CONCERNS（BL-04/05/06 不可执行/不一致）；
  跨模块契约 FAIL（7 + 1 blockers）；registry-assisted consistency NOT RUN（无 entity registry）；
  governance mirrors FAIL。
- **Director Panel**：CD / TD / PR 均 NOT READY；AD SKIPPED。CoV 5 问 FAIL 存活。
- **Handoff**：人工裁决 8 项耗尽复审残余；完成 Store J3 与 VR re-review #5；6/6 Approved 后重跑。

## Run 3 — Specification → Architecture — 2026-07-20 — FAIL（Not advanced）

- **Required artifacts**：Systems Map PASS；MVP CDDs **FAIL**（5/6，Delivery In Review）；
  per-system review **FAIL**；cross-review run 02 **FAIL**。
- **Quality/risk**：budget PASS；Store/VR 契约完整性 PASS（79/152 AC）；三条主数据流 PASS；
  Delivery → VR/Store **FAIL**（唯一存活 blocker B-01）；registry consistency NOT RUN；mirrors PASS。
- **B-01 决定性 blocker**：cutoff-ε attempt 在健康路径下可使 `dead` 提交晚于 24h 硬边界；
  任何修复方向都改变 Specification 行为或 T0，须 owner 裁决。
- **Director Panel**：CD/PR NOT READY；TD REJECT/NOT READY；AD SKIPPED。CoV 5 问 FAIL 存活。
- **Handoff**：owner 裁决 B-01（cutoff 含 finalization budget / 临界原子终止 / 修订 24h 承诺）；
  新授权后一轮窄修订 + fresh 复审。
- Post-panel module-index Next Steps 同步后 SHA `6df50c3a…`。

## Run 4 — Specification → Architecture — 2026-07-20 — PASS（Advanced）

- **前置**：owner 裁决 B-01（actual-result 原子 `die(deadline_exceeded)`，见
  `design/cdd/reviews/delivery-deadline-adjudication.md`）；entity registry 建立。
- **Required artifacts 6/6 PASS**：system map；6/6 CDD Approved（290 unique canonical AC）；
  per-system review evidence；`design/registry/entities.yaml`；cross-review run 03 PASS；
  架构候选输入（technical preferences、OpenAPI、tr-registry、4 份 Accepted ADR）。
- **Verification**：trace 290/290 + 4/4 NSBR；24/24 families；OpenAPI 15 paths / 77 schemas /
  220 refs 全解析；AdminCommandError(13)/ReadError(9) 稳定公开 wire；B-01 与 no-send 语义区分；
  governance mirrors 一致。
- **Stage decision**：stage.txt 推进 `Specification` → `Architecture`；
  不授权源码/迁移/测试/构建，不授权 Architecture → Pre-Implementation gate。
- **Handoff**：fresh 独立 Architecture package review（结果见
  `docs/architecture/architecture-review-archive.md`）；停在 Architecture。

## Integration Gate Supersession — 2026-07-24 — OWNER_AUTHORIZED

- **Owner authorization**：`wsman`，记录时间 `2026-07-24T00:46:29+08:00`。
- **Superseded gate**：`G5-CANARY=SUPERSEDED_NOT_RUN`；不追溯声明长期 Canary 已执行或通过。
- **Replacement**：`G5-IMPORT-QUALIFICATION`，仅作为 IB6 exact-history import 的资格门禁。
- **Run contract**：单个 `notification-canary` protected run；无最短持续时间；hard timeout 60 分钟；
  至少 8 个 distinct non-replay accepted keys，覆盖
  `2 repositories × {issue,push} × 2 vendor IDs` 的八个 cell；每条在 accepted 后 600 秒内 delivered。
- **前置与阻塞条件**：`G3-QUEUE=PASS`、`G4-E2E=PASS`、OpenSlack `v0.2.0` immutable release；frozen
  commit/tree/image/config/route identities；restart/response-loss、权限隔离、receipt/DB/vendor 对账与
  payload/secret scan 均通过；unresolved duplicate/conflict/dead/correctness/security blocker 全部为零。
- **授权边界**：只授权在其余 IB6 preconditions 也满足后执行 `IB6_HISTORY_IMPORT_ONLY`。不授权
  `LIVE_VERIFIED`、IB7/default cutover、OpenSlack 0.3.0、production-ready 或任何 destructive retirement。
- **Append-only discipline**：`docs/testing/ib4-r1-local-report.json` 和
  `docs/testing/acceptance-report.json` 保持原样；未来 qualification 结果创建新
  `negentropy_laby.ib6_preconditions.v2` receipt，不回写历史 evidence。
- **Machine receipt**：
  `integration/gates/g5-import-qualification-supersession.json`，SHA-256
  `2d1ee8da4bf3433732384bc1b70afd264b3455c9c8a0764e7c16b24f65ba54d6`。

此条目记录 contract supersession，不是 `G5-IMPORT-QUALIFICATION=PASS` 运行证据，也不推进项目 stage。
