# Amendment Log — T0 Core

> 宪法修订历史（append-only）。每次正式修订附详细证据至
> `memory_bank/t3_archive/amendments/`。

| Version | Date | Trigger | Summary | Evidence |
|---|---|---|---|---|
| 0.1 (Draft) | 2026-07-18 | 项目立宪 | 初版宪法：BL-01 核心论点 + BL-02..BL-06 五条法律（投递语义 / 持久化原子性 / 有界重试与死信 / 边界 / 可观测性）。 | — |
| 0.1 (Draft, rev 2) | 2026-07-18 | 草案多视角审查 + 用户核验 | 修订：BL-02 分离**入站强去重**与**出站 best-effort 幂等**（禁止无条件注入 body）；BL-05 增补 SSRF 安全边界；BL-01 演进改为指标驱动、不锁定具体顺序；active_context 区分已绑定法律与候选架构；审查证据归档至 T3；补 `release_state.md`（该文件已于 2026-07-21 退役）。 | `../t3_archive/reviews/review-index.md`（附录） |
| 1.0 (Accepted) | 2026-07-18 | 用户签发 | BL-02 增幂等冲突规则（不可变 `request_fingerprint` + 同键异指纹 → `409 IdempotencyConflict`）与 `caller_id` 服务端推导（拒自报）；BL-05 SSRF 绑定 DNS pinning + 不跟重定向 + 全非公网禁（完整清单进 ADR）；`release_state.md` 删 CLI；PostgreSQL / API Key / SSRF 升为已批准架构决定（细节进 ADR / T1）；BL-01..BL-06 全部 Accepted。 | `../t3_archive/amendments/amendment-v1.0-2026-07-18.md` |
| —（流程记录，非宪法修订） | 2026-07-21 | 所有者授权文档 consolidation | 过程证据归档压缩：13 份 review log/cross-review → `design/cdd/reviews/review-archive.md`；2 份 architecture review → `docs/architecture/architecture-review-archive.md`；4 份 gate run → `memory_bank/t3_archive/gate-archive.md`；constitution-draft 审查并入 `review-index.md` 附录；删除占位文件 `release_state.md`、`production/session-state/`、`docs/architecture/README.md`；阶段镜像规则四改三。原件 verdict/SHA-256 均保留于各档案。 | 各档案头部 consolidation 注记 |
