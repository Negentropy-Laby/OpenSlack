# Review Index — T3 Archive

> memory_bank 审查证据索引。每行一个 source artifact（去重键 = Source Artifact）。
> 由审查类工作流（design-review 等）维护；新增行不替换既有条目。
> **2026-07-21 consolidation**：逐模块 review log、cross-review 与 architecture review 原件已合并归档；
> Review Log 列指向 `design/cdd/reviews/review-archive.md`（模块评审 + cross-review）与
> `docs/architecture/architecture-review-archive.md`（架构包审查）的对应章节。

| Source Artifact | Review Type | Verdict | Date | Review Log |
|---|---|---|---|---|
| `design/cdd/product-concept.md` | design-review (lean) | APPROVED（独立复审 2026-07-18） | 2026-07-18 | `../../../design/cdd/reviews/review-archive.md` §product-concept |
| `design/cdd/notification-store.md` | design-review (lean) + focused compatibility/deadline/public-wire | APPROVED（fresh public-wire focused review #6；79 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Notification Store |
| `design/cdd/vendor-registry.md` | design-review (lean) | APPROVED（fresh focused review #6；method source closed；152 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Vendor Registry |
| `design/cdd/caller-access.md` | design-review (lean) | APPROVED（fresh public-wire focused review #3；15 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Caller Access |
| `design/cdd/delivery.md` | design-review (lean) | APPROVED（B-01 owner adjudication + fresh focused review；20 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Delivery |
| `design/cdd/operations-control.md` | design-review (lean) | APPROVED（limited-exception re-review #3；14 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Operations Control |
| `design/cdd/reliability-observability.md` | design-review (lean) | APPROVED（limited-exception re-review #3；T1 ownership closed；10 AC） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Reliability Observability |
| cross-CDD corpus（6 CDD + concept） | review-all-gdds (full; two fresh passes) | FAIL（5/6 Approved；1 Delivery deadline blocker） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Cross-CDD Reviews run 02 |
| cross-CDD corpus + registries | consistency-check + review-all-gdds (fresh independent) | PASS（6/6 Approved；290/290 AC + 4/4 NSBR） | 2026-07-20 | `../../../design/cdd/reviews/review-archive.md` §Cross-CDD Reviews run 03 |
| `docs/architecture/architecture.md` | Architecture package review (fresh independent) | APPROVED（无 blocker；实现未开始） | 2026-07-20 | `../../../docs/architecture/architecture-review-archive.md` §Review #1 |
| Architecture advisory closures | fresh independent re-review | APPROVED（4/4 advisories closed at Architecture scope） | 2026-07-20 | `../../../docs/architecture/architecture-review-archive.md` §Review #2 |
| B1–B4 implementation corpus | implementation closure self-review + mechanical acceptance | READY FOR INDEPENDENT REVIEW（266/266 AC mapped；build/vet/race/race×5 PASS；不得视为 independent APPROVED） | 2026-07-22 | `implementation-review-archive.md` §B1–B4 Closure Self-Review |
| B1–B4 implementation corpus（addendum） | closure hardening self-review + mechanical acceptance rerun | READY FOR INDEPENDENT REVIEW（266/266 AC explicitly registered；migration/OpenAPI/race×5 PASS；不得视为 independent APPROVED） | 2026-07-22 | `implementation-review-archive.md` §B1–B4 Closure Self-Review Addendum |
| B1 + B2 implementation closure | fresh independent review | APPROVED（0 blocker） | 2026-07-22 | `implementation-review-archive.md` §B1 + B2 Fresh Independent Closure Review |
| B3 Caller Access + Vendor Registry implementation | fresh independent re-review | APPROVED（0 blocker） | 2026-07-22 | `implementation-review-archive.md` §B3 Fresh Independent Re-Review |
| B4 Delivery implementation | fresh independent review | APPROVED（0 blocker；后续 Delivery delta 纳入 B6/final cross-review） | 2026-07-22 | `implementation-review-archive.md` §B4 Fresh Independent Review |
| B5 Operations Control + Reliability Observability | fresh independent review + bounded correction | APPROVED（0 blocker / 0 non-blocking） | 2026-07-22 | `implementation-review-archive.md` §B5 Fresh Independent Review |
| B6 deployment / lifecycle / fault / capacity / PITR | fresh independent review + bounded correction | APPROVED（0 blocker / 0 non-blocking） | 2026-07-22 | `implementation-review-archive.md` §B6 Fresh Independent Review |
| B1–B6 batch implementation corpus | final per-batch closure regression reviews | APPROVED（B1/B2、B3、B4、B5、B6 各 0 blocker；不替代 cross-batch verdict） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Batch Review Correction and Final Closure |
| B1–B6 complete implementation corpus | fresh independent cross-batch review attempt 1 | NEEDS REVISION（仅 manifest drift blocker；实质 0 blocker；容量基线边界 1 non-blocking） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Cross-Batch Closure Attempt 1 |
| B1–B6 complete implementation corpus | fresh independent final cross-batch review | APPROVED（0 blocker；1 disclosed capacity-baseline limit） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Cross-Batch Closure Final Review |
| B1–B6 complete implementation corpus | fresh independent final truth/correctness audit | NEEDS REVISION（3 blockers corrected；awaiting new-manifest re-review；supersedes preceding final label） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Cross-Batch Final Review Correction |
| B1–B6 complete implementation corpus | fresh independent cross-batch re-review attempt 3 | NEEDS REVISION（active truth-surface drift corrected；awaiting new manifest） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Cross-Batch Re-Review Attempt 3 |
| B1–B6 complete implementation corpus | fresh independent final cross-batch re-review | APPROVED（0 blocker / 0 new non-blocking；local submission-ready） | 2026-07-22 | `implementation-review-archive.md` §B1–B6 Cross-Batch Closure Final Re-Review |

## 附录：Constitution Draft v0.1 Review — 2026-07-18

> 退役原件 `constitution-draft-v0.1-review-2026-07-18.md`（SHA `a5bad7c4…`）的内容并入本附录。
> 草案 v0.1 的多视角审查与用户核验证据；sign-off 记录见 `../amendments/amendment-v1.0-2026-07-18.md`。

### 三路对抗式审查（草案 v0.1 初版）

- **过度设计审查（revise）**：must-fix — BL-01 与 BL-05 系统边界重叠 → BL-01 剥离边界、BL-05 独占；
  采纳 — BL-06 软化 PagerDuty 暗示；BL-02 重述过度断言；BL-05 single-region/ordering 降为 non-goal。
- **作业覆盖审查（revise）**：must-fix — Q3 演进路径无绑定立场 → BL-01 增补演进立场；
  采纳 — Q2 长期不可用显式 design test；可靠性姿态单一锚点。
- **CDD 合规审查（pass）**：0 must-fix；采纳 — Law 3 钉死 `MAX_ATTEMPTS` 常量；Law 4 具体化。

### 用户核验反馈（rev 1 → rev 2）

1. **幂等契约混淆两个边界**（阻塞）→ BL-02 拆分入站强去重 + 出站 best-effort（缺省不写入）。
2. **安全边界缺失**（阻塞）→ BL-05 增补目标地址限制（SSRF / 开放代理防护）。
3. BL-01 演进锁定顺序过早 → 指标驱动 + ADR + amendment。
4. active_context 区分"已绑定法律"与"候选架构（未批准）"。
5. 审查证据归档至本文件；`current_state` / `amendment_log` 改为引用。
6. 补建 `release_state.md`（占位；该文件已于 2026-07-21 consolidation 退役删除）。

### 相关产物

- 宪法正文：`../../t0_core/basic_law_index.md`
- 活动上下文：`../../t0_core/active_context.md`
