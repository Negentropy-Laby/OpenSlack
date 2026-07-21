# Design Review Archive — CDD 模块评审与交叉评审

> **2026-07-21 owner-authorized consolidation**：本档案合并并取代以下退役原件，原件已删除，
> 其日期、轮次、verdict、SHA-256 与 blocker 计数压缩保存于本档案：
>
> - `product-concept-review-log.md`、`caller-access-review-log.md`、`delivery-review-log.md`、
>   `notification-store-review-log.md`、`notification-store-cleanup-log.md`、
>   `notification-store-preflight-compat-log.md`、`notification-store-observability-contract-log.md`、
>   `operations-control-review-log.md`、`reliability-observability-review-log.md`、
>   `vendor-registry-review-log.md`
> - `../cross-review-2026-07-20.md`、`../cross-review-2026-07-20-02.md`、`../cross-review-2026-07-20-03.md`
>
> 不属于本档案（保留为独立决策文档）：`delivery-deadline-adjudication.md`（B-01 裁决）、
> `deadline-backlog-pressure-analysis-2026-07-20.md`（Advisory 2 分析）。
> 评审均为 `--depth lean`、独立 fresh-session 只读复审（注明 same-thread 者除外）。

## product-concept（概念层）

| 日期 | 轮次 | Verdict | 要点 |
|---|---|---|---|
| 2026-07-18 | Initial review | NEEDS REVISION | 4 blocking（BL-05 责任边界歧义 ×3、BL-01 演进顺序漂移）+ 3 non-blocking；7 处措辞级修订已应用 |
| 2026-07-18 | Batch B 独立复审 | **APPROVED** | 7 findings 全部 RESOLVED；BL-01..06 ALIGNED；2 项 Low advisory 润色经复审员 sanction 应用 |

## Notification Store（79 AC）

Pre-review cleanup（非 design-review）：2026-07-18，B0→B3.1 四轮 bounded correction；
specialist 咨询（lead-programmer / security-engineer / qa-lead；performance-analyst waiver 经用户批准）；
D1–D5 rulings（intake 双契约、delivery cycle、Delivery 拥有 retry/die policy 与 lease_ttl、三类错误分离）；
CDD SHA `a5c9e909…` → `bf316652…`。

| 日期 | 轮次 | Verdict | Blocker | CDD SHA |
|---|---|---|---|---|
| 2026-07-18 | Initial review | NEEDS REVISION | 4（操作契约、audit 矛盾、content_type、Worked Example） | `14cb512e…` |
| 2026-07-18 | Bounded revision #1 | pending | 63 AC | `447e2eb4…` |
| 2026-07-18 | Re-review #1 | NEEDS REVISION | 首轮 4 项 RESOLVED；新增 5 | — |
| 2026-07-18 | Revision #2 | pending | 65 AC | `9ee36a88…` |
| 2026-07-18 | Re-review #2 | NEEDS REVISION | 累计 9 项 RESOLVED；新增 4 | — |
| 2026-07-18 | Revision #3 | pending | 74 AC | `bf18a722…` |
| 2026-07-18 | Re-review #3 | NEEDS REVISION | 累计 13 项 RESOLVED；新增 2（读模型） | — |
| 2026-07-18 | Revision #4 | pending | 79 AC | `f359cae2…` |
| 2026-07-18 | Re-review #4 | **APPROVED** | 15 项全部 RESOLVED，无新 blocker | final `0ec4ce04…` |
| 2026-07-20 | Limited exception + re-review #5 | **APPROVED** | 3 项授权 delta（unknown_result.error_code、J3 wording、replay-aware claim 排序）；79 AC 不变 | candidate `8cce41c6…`；final `4c4f4a7d…` |
| 2026-07-20 | B-01 actual-result 扩展 | **APPROVED** | actual-result `deadline_exceeded` 原子 die；Store 数据字典一处修正 | `3ca1d563…`→`a81f7a8c…`；final `5dce9e11…` |
| 2026-07-20 | Fresh public-wire focused #6 | **APPROVED** | payload_base64、30s lease、B-01 回归全部 ALIGNED | `20368484…` |

### Delivery preflight 兼容修订（独立日志并入）

`policy_termination` reason 集扩展为 6 项（attempt_limit、deadline_exceeded、vendor_unavailable、
destination_rejected、credential_unavailable、request_unbuildable），均为发送前确定性终止、不计数。
Focused review #1 NEEDS REVISION（2 blockers）→ 修正 `e11d334e…` → re-review #2 NEEDS REVISION
（unknown_result.error_code 残余）→ owner 批准 review-cap exception → limited-exception re-review
**APPROVED**（`8cce41c6…`；final `4c4f4a7d…`）。

### Store ↔ Observability 契约 ratification（独立日志并入）

消费契约双向闭合：仅 `kind=system + read_all_notifications` global query；只消费
pending_count / oldest_pending_age_seconds / dead_count；no-pending age = 0；不读 attempt history。
残余 T1 threshold ownership 冲突经人工裁决（T1 固定 `dead>0 for 5m`）后，
limited-exception re-review **APPROVED**（T1 SHA `07e63e6b…`）。

## Vendor Registry（152 AC）

| 日期 | 轮次 | Verdict | Blocker | CDD SHA |
|---|---|---|---|---|
| 2026-07-19 | Initial review | NEEDS REVISION | 8（禁用语义/快照绑定、OC 责任与 DAG、ActorContext、管理操作集、不可变版本、幂等持久化、处理顺序、集合查询） | `6925de25…`（72 AC） |
| 2026-07-19 | Bounded revision E1–E9 + F0 | pending | 8 blocker 逐条映射关闭 | `8ba5cda1…`（81 AC） |
| 2026-07-19 | Re-review #1（same-thread） | NEEDS REVISION | 7（owning_scope、URL/SSRF 元组、端点配置契约、写操作错误集、数据模型引用、C15、Configuration/CIDR） | — |
| 2026-07-19 | Revision G1–G7 | pending | 106 AC | `9ea98d40…` |
| 2026-07-19 | Re-review #2（same-thread） | NEEDS REVISION | 8（含 G1–G7 残余）；**supersede 此前"7 blockers 已闭合"的表述** | — |
| 2026-07-20 | Revision H1–H8 | pending | 139 AC；四路 adversarial hardening | `da440a18…` |
| 2026-07-20 | Re-review #3（same-thread） | NEEDS REVISION | 6（I1–I6） | — |
| 2026-07-20 | Revision I1–I6 | pending | 147 AC；Pre-3C verification CLEAN | `0475c25f…` |
| 2026-07-20 | Re-review #4（same-thread） | NEEDS REVISION | 3 契约级（J1 读错误未闭合、J2 字节相等不可实现、J3 与 NS 契约冲突） | — |
| 2026-07-20 | 用户裁决 J1–J3 + Batch 4B（4B-VR + 4B-NS） | pending | J3=c：VR 为防枚举权威，NS 改合并 wording | NS `8cce41c6…`；VR `6811c592…` |
| 2026-07-20 | Independent re-review #5（fresh） | **APPROVED** | J1–J3 全部 RESOLVED；152 AC | final `acb0133c…`；mirror `265680e4…` |
| 2026-07-20 | Fresh focused #6 | **APPROVED** | method 来源、credential 边界、OpenAPI 对齐 | `ba53b3a9…` |

## Caller Access（15 AC）

| 日期 | 轮次 | Verdict | 要点 |
|---|---|---|---|
| 2026-07-20 | Review #1 | NEEDS REVISION | 6 blockers（principal 不变量、key 管理原子性、attenuation、verifier 泄露、J3 外部依赖、C1–C15）；`fa12e506…` / 14 AC |
| 2026-07-20 | Correction #1 | pending | 208 行 / 15 AC；`8c8611b0…` |
| 2026-07-20 | Re-review #2 | **APPROVED** | 1–4、6 RESOLVED；#5 外部 J3 gate `PENDING_EXTERNAL_J3`；status-only `352feae6…` |
| 2026-07-20 | External J3 gate closure | `EXTERNAL_J3_CLOSED` | NS re-review #5 + VR re-review #5 均 APPROVED；统一公开 `404 VendorUnavailable`；`b409cdeb…` |
| 2026-07-20 | Fresh public-wire focused #3 | **APPROVED** | payload_base64 ingress 闭合；`94433bee…` |

## Delivery（20 AC）

| 日期 | 轮次 | Verdict | 要点 |
|---|---|---|---|
| 2026-07-20 | Review #1 | NEEDS REVISION | 7 blockers；`c35a0b3c…` / 16 AC |
| 2026-07-20 | Correction #1 | pending | 用户锁定 credential-before-SSRF；230 行 / 20 AC；`4fb42311…` |
| 2026-07-20 | Re-review #2 | NEEDS REVISION / BLOCKED | 残余：24h wall-clock、VR `INVALID_COMMAND` 映射、DL-15 tag；新增 context mapping；外部 gate 未闭 |
| 2026-07-20 | Limited exception correction | pending | `cycle_send_cutoff` + 5s claim budget 等 4 项闭合；`80530ff2…` |
| 2026-07-20 | External gates closed | — | NS #5 与 VR #5 均 APPROVED |
| 2026-07-20 | Re-review #3 | NEEDS REVISION | 24h finalization 反例存活（cutoff-ε attempt 场景）；review cap 用尽，提交人工裁决 |
| 2026-07-20 | **B-01 用户裁决** | 见 `delivery-deadline-adjudication.md` | retryable actual result 在 cutoff 后完成 ⇒ 当前写回原子 `die(deadline_exceeded)`，计数 +1、禁 next_attempt_at |
| 2026-07-20 | Fresh focused #4 | **APPROVED** | candidate `06448368…`；final `9c045aa3…` |

## Operations Control（14 AC）

| 日期 | 轮次 | Verdict | 要点 |
|---|---|---|---|
| 2026-07-20 | Review #1 | NEEDS REVISION | 4 blockers（attenuation、redaction denylist、preview 零写、C1–C15）；`d1b26ee6…` |
| 2026-07-20 | Correction #1 → Re-review #2 | NEEDS REVISION | 2 残余（actor context 形状、list/preview/execute allowlist）；`597bdc56…` |
| 2026-07-20 | Limited exception → Re-review #3 | **APPROVED** | 闭合 replay context 与全部 response envelope；`6adc82b0…`；final `4900107f…` |

## Reliability Observability（10 AC）

| 日期 | 轮次 | Verdict | 要点 |
|---|---|---|---|
| 2026-07-20 | Review #1 | NEEDS REVISION | 5 blockers（C1–C15、no-pending age、scrape 失败语义、固定阈值 vs T1、attempt-history 漂移）；`c10e0961…` |
| 2026-07-20 | Correction #1 → Re-review #2 | NEEDS REVISION | 1 残余：T1 `qa_context.md` threshold ownership 冲突；`7a21cbde…` |
| 2026-07-20 | Limited exception（CDD + T1）→ Re-review #3 | **APPROVED** | T1 固定 `dead>0 for 5m`，仅 channel/routing 属部署配置；CDD `b01bbb19…`；final `976b2cb7…` |

## Cross-CDD Reviews（/review-all-gdds）

| 日期 | Run | Verdict | 要点 |
|---|---|---|---|
| 2026-07-20 | 01 | **FAIL** | 1/6 Approved；8 个跨契约 blocker（vendor 防枚举、Delivery identity seam、VR totality、24h 硬边界、Operations actor/response、Observability ownership、Store 内部矛盾）；`/consistency-check` 因无 entity registry NOT RUN |
| 2026-07-20 | 02（fresh） | **FAIL** | 5/6 Approved；限定例外闭合 8 项残余中的 7 项；唯一存活 blocker = B-01 24h finalization 反例 |
| 2026-07-20 | 03（fresh，含 consistency-check + entity registry） | **PASS — Architecture-ready** | 6/6 Approved；290 unique canonical AC（79+152+15+20+14+10）；trace 290/290 + 4/4 NSBR；24/24 families；OpenAPI 15 paths / 77 schemas / 220 refs 全解析；B-01 与 no-send deadline 均 PASS |

Run 03 reviewed SHA-256 基线：module-index `73520aa4…`、NS `20368484…`、VR `ba53b3a9…`、
Caller `94433bee…`、Delivery `dc8708fd…`、OC `4900107f…`、RO `976b2cb7…`、
entities.yaml `b197e7ea…`、openapi.yaml `1ab4b4cf…`、tr-registry.yaml `3e0e36df…`、
adr-registry.yaml `601b5459…`。
