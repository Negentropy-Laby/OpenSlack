# Architecture Review Archive — 2026-07-20

> **2026-07-21 owner-authorized consolidation**：本档案合并并取代退役原件
> `architecture-review-2026-07-20.md`（SHA `0d00ef02…`）与
> `architecture-review-2026-07-20-advisory-closures.md`。原件已删除；
> 两轮审查的 verdict、SHA-256 基线、advisory 闭合与修正记录压缩保存于本档案。

## Review #1 — Architecture package — APPROVED

- **Method**：fresh-session independent read-only review；stage = Architecture；无实现证据。
- **Scope**：提交入口文档、6/6 Approved CDD、技术基线、主架构、数据模型、4 份 ADR、OpenAPI、
  威胁模型、runbook、测试策略、UX 文档、entity/trace/ADR registries、control manifest、状态镜像。

### Reviewed snapshot（SHA-256）

| Artifact | SHA-256 |
|---|---|
| Review-package aggregate | `b00dbdc0bc818e54c441aef0a55470051c57feb5ada6a8d67e6988d9a1ee518d` |
| `architecture.md` | `b382a0bd7aefe739adaba9f1e3d0f1b456d6f368731ca0527a5d68cc206209c8` |
| `docs/api/openapi.yaml` | `1ab4b4cff43ee62e62186e192396fef7c1038651bfda51edcb16218c0921dca2` |
| `tr-registry.yaml` | `3e0e36dfb7eb8a9727f981b3b8f356df53cc39df563cf0a023779f3fa8bd5323` |
| `design/registry/entities.yaml` | `b197e7ea15d80ac90f2db80c838e53f3e44d7680982740da3d3de72e609d4f07` |
| cross-review run 03 | `e7949eda97f2cb7baca8d58b6f067c39963dcd57896b44b3207fe93a5a0a9814` |

### Results（摘要）

- 6/6 CDD Approved；290 canonical AC trace 290/290 + 4/4 NSBR。
- OpenAPI 15 paths / 15 operation IDs / 77 schemas / 220 local refs 全解析；YAML registries 无重复键。
- ownership、事务边界、lease/OCC/recovery、配置与 secret 生命周期一致；SSRF、重放、越权等对抗场景
  均在设计层闭合并有计划证据。
- 无源码、测试、迁移、构建、部署或运行证据声明。

### Non-Blocking Advisories（2 项）

1. production readiness 前明确 API-key HMAC pepper 的 rotation / recovery dependency / invalidation。
2. Pre-Implementation 证明 `DEADLINE_CLAIM_BUDGET` 在 backlog pressure 下成立（含单行 cutoff-epsilon）。

> "These advisories do not authorize this project to enter Pre-Implementation."

## Review #2 — Advisory closures — APPROVED

- **Method**：fresh-session independent read-only re-review（四个独立 reviewer pass 合并；SHA 重算）。
- **Verdict**：两项 advisory 均在 Architecture 范围闭合（spec/analysis/test-design 产出；
  实例化与证明执行 deferred）。无 blocking finding 存活。

### Advisory 1（pepper 生命周期）— CLOSED AT ARCHITECTURE SCOPE

产出：ADR-0003 Decision (a)–(h) + Amendments（rotation/recovery/invalidation 全程）；
data-model.md 加法 `pepper_id` 列注记；architecture.md `API_KEY_PEPPER_ACTIVE/PREVIOUS` 结构化配置
（启动 env allowlist、fail-closed）；runbook 常规/紧急/丢失程序；technical-preferences 一行；
adr-registry / tr-registry 注册。Deferred：secret store 实例化、操作命令、演练节奏、entities.yaml 注册。

### Advisory 2（deadline backlog 证明）— CLOSED AT ARCHITECTURE SCOPE

产出：`design/cdd/reviews/deadline-backlog-pressure-analysis-2026-07-20.md`（N 行结构推导、
条件不变式 `dead_at ≤ cycle_deadline`（C1–C4）、B1–B5 分解面、AC 映射测试设计）；
test-strategy 场景 12–14 + Capacity-Baseline 条款。Deferred：数值测量与 fault-injection 执行。
未新增 AC / CTRL 行 / config key / schema 列；Change Rule 未触发；CTRL-024 保持。

### Changed artifacts（SHA-256）

| Artifact | SHA-256 |
|---|---|
| `adr-0003-api-key-authorization.md` | `1de7da072c887ed3da8fb88c90d877152ce6d9000c52e49ae5354485b93c3fd4` |
| `data-model.md` | `2133d26294827be9bd1d6917ec1588e2a194a7eff81d2543d588d4806e7353f8` |
| `architecture.md` | `89ff03a087aecdfb04177cc2e0b3e821b5c50eaf84852a4fec8622d5461562eb` |
| `standards/technical-preferences.md` | `a646d202ca936646008545f140017b6125881efcfca5611256219de7b7815116` |
| `docs/operations/runbook.md` | `eaa1ae409edde947216b3f10aad3bbec3aee8738b75f76de6bf545631a8f2a54` |
| `adr-registry.yaml` | `e3aafbbb6d52bcdf066f1597e676f8bf4bedc98c5250b163ef3619fee668a7b8` |
| `tr-registry.yaml` | `93c897ce63a3c2a54ba4ecceae9f5c35abe53a93f7f2982dd2ad5abdd44f8ccf` |
| `docs/testing/test-strategy.md` | `eb8d4739a5d1c730b2745cd0271be59969d8aeea66b05a5951360165f84ff907` |
| `deadline-backlog-pressure-analysis-2026-07-20.md` | `5df494abc0c1cf6b290bb06e35e5c500dfe44af61a684a7b2cf85e6116090cac` |

### DO_NOT_TOUCH pinned（节选）

6 份 CDD（NS `20368484…`、VR `ba53b3a9…`、Caller `94433bee…`、Delivery `dc8708fd…`、
OC `4900107f…`、RO `976b2cb7…`）；ADR-0001 `b30c07cf…`、ADR-0002 `4a931b98…`、ADR-0004 `0bcfb2f8…`；
control-manifest `3b62c193…`；requirements-traceability `082621b1…`；basic_law_index `c6ead619…`；
amendment_log `2e00d212…`；workflow_contract `432adc77…`；stage.txt `e8c5671c…`（= Architecture）；
`release_state.md` `2c1f5d60122073607c3349a1c1917a9ea17596c447b6b70e9d844ea5d35806c3`
（该文件已于 2026-07-21 consolidation 退役删除，此为最后 pinned SHA）。

### Post-review Corrections #1（作者应用，verdict 保持 APPROVED）

1. Advisory #1（citation drift）RESOLVED — deadline 分析的行号引用改为 section anchors。
2. Advisory #2（emergency step (e)(4) 边界）RESOLVED — ADR-0003 澄清仅丢弃被妥协 generation。

### Post-review Corrections #2（advisory #3/#4 闭合，fresh re-verification APPROVED）

3. Advisory #3 RESOLVED — `API_KEY_PEPPER_ACTIVE/PREVIOUS` 注册进 entities.yaml config_map
   （authority = ADR-0003；value 仅非密标记，CTRL-016 保持）；entities.yaml 新 SHA `e7be54c7…`。
4. Advisory #4 RESOLVED — 全部未哈希 registry/ADR 已 pin（SHA 见上表）。

四项 advisory 全部闭合；stage 保持 Architecture；Architecture→Pre-Implementation gate 未运行。

## Post-Consolidation Note — 2026-07-21

2026-07-21 owner-authorized 文档 consolidation 中，`adr-0003-api-key-authorization.md` 的 ## Amendments
引用由本档案的退役原件名改为 `architecture-review-archive.md`（纯引用改名，无行为变更）。因此
ADR-0003 当前 SHA 不再等于上文 pinned `1de7da07…`；其余 pinned artifact 均未受影响。
`memory_bank/t3_archive/amendments/amendment-v1.0-2026-07-18.md` 作为 2026-07-18 历史记录，
保留其对 `release_state.md` 与 constitution-draft review 原件的当时路径引用，不做回溯改写。

## Owner Amendment Record — ADR-0005 Pre-IB6 Gate Supersession — 2026-07-24

- **Authority**：owner `wsman`，`2026-07-24T00:46:29+08:00`。
- **Disposition**：`G5-CANARY=SUPERSEDED_NOT_RUN`；replacement =
  `G5-IMPORT-QUALIFICATION`。
- **Scope**：仅改变 IB6 history import 的前置 Gate；不改变 runtime、wire/schema、delivery authority、
  idempotency、retry、receipt、migration 或 security contract。
- **Non-authorization**：不授权 `LIVE_VERIFIED`、IB7、OpenSlack 0.3.0、production readiness 或
  destructive retirement。
- **Evidence discipline**：旧 IB4/G1 evidence 未修改；Gate archive 只追加；qualification 运行尚未发生，
  本记录不签发 `G5-IMPORT-QUALIFICATION=PASS`。
- **Traceability**：该变更是 integration/release Gate governance，不新增或修改 290 个 canonical CDD AC，
  因此不触发 `tr-registry.yaml` / `ac-evidence.json` Change Rule。
- **Review characterization**：owner-authorized contract amendment + mechanical author verification；不是
  independent live/production review。

### Supersession artifact snapshot

| Artifact | SHA-256 |
|---|---|
| `docs/architecture/adr-0005-openslack-handoff-integration.md` | `1827b5337fbf1f11ee0e9f5d38866b03750d3d596c957b42460521db7c940bf8` |
| `docs/architecture/adr-registry.yaml` | `ce6e116b7bf2d048aba702d305be674c630f5ec1eb333b7bf5c3b200576c1482` |
| `docs/operations/runbook.md` | `2119418e3103d8c8d95c494fe4d7fd65dd10be5b26aea014e2843cb3761b9a6a` |
| `integration/schemas/integration-gate-supersession.v1.schema.json` | `23e756e1160a569c145b8dd38059089b7607727532ca21f7faa97c68ca95940c` |
| `integration/schemas/ib6-preconditions.v2.schema.json` | `0ed86c4d40bc6784275f3b8213eca83fde50fa31fb757fa78dc6bdb71b18e133` |
| `integration/gates/g5-import-qualification-supersession.json` | `2d1ee8da4bf3433732384bc1b70afd264b3455c9c8a0764e7c16b24f65ba54d6` |
| `memory_bank/t3_archive/gate-archive.md` | `f3e481ccf3a6c9e995dc5e900afec2b70d89deb4c765bd0aaf00f99c65512b32` |

### Mechanical verification

- decision receipt validates against `negentropy_laby.integration_gate_supersession.v1`;
- both JSON schemas compile as JSON Schema Draft 2020-12;
- YAML registries parse with no duplicate keys;
- local Markdown links resolve;
- historical `ib4-r1-local-report.json` and `acceptance-report.json` remain byte-identical to `main`.
