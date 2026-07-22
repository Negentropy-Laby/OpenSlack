# Workflow Contract

> **Status**: manual / uninitialized —— rc_wsman 未安装 CDD runtime。
> 本文件为手工维护的最小契约镜像，非 `/constitute` 或 adapter sync 生成物。

## Canonical Source

- Project-local workflow catalog：**missing**（无 `workflow/workflow-catalog.yaml`）
- Framework manifest：**missing**（无 `cdd-manifest.toml`）
- Adapter sync script：**missing**（无 `scripts/sync_adapters.py`）
- Gate policy：governed advisory（参照外部 CDD framework）
- 方法论来源：外部 Constitution-Driven-Development framework；rc_wsman 手工遵循

## Project Activation

- **Domain**: Product
- **Current stage source**: `../../production/stage.txt` = `Implementation`
- **Review mode**: lean（per-run override；repo 级 `review-mode.txt` **missing**）
- **Strict QA mode**: off
- **Workflow catalog checksum**: N/A（catalog missing）

## Canonical Project Evidence

- 阶段：`../../production/stage.txt`
- 模块边界：`../../design/cdd/module-index.md`
- 门禁报告：`../t3_archive/gate-archive.md`
- 审查日志：`../../design/cdd/reviews/review-archive.md`、`../t3_archive/reviews/review-index.md`

## Conditional Requirements

| Requirement | Current decision | Source |
|-------------|------------------|--------|
| Product surface profile | **MANUAL / PRESENT** — API/operator/admin/metrics；无 GUI/CLI | `../../design/ux/surface-profile.md` |
| Interaction patterns | **MANUAL / PRESENT** — submit/status/preview-execute/partial result | `../../design/ux/interaction-patterns.md` |

> Product 有 HTTP API 集成者与操作员界面；surface/interaction 证据已建立。无终端 GUI 不等于无 UX。

## Deferred T2（本轮不创建）

- `current_roadmap.md`：待 primary `production/project-roadmap.md` 存在，或安装本地 workflow catalog
  后由 `/cdd-status` 生成并镜像。本轮不伪造生成物。
- `framework_contract.md` / `adapter_state.yaml`：待完整 `/constitute` 初始化。
  不记录虚假的 adapter freshness。
