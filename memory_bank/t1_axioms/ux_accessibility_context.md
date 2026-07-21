# UX And Accessibility Context

> T1 supporting context。UX 与可达性假设的索引层；不替代 `../../design/ux/`。
> 权威来源：`../../design/ux/surface-profile.md`、`../../design/ux/interaction-patterns.md`、`../../design/cdd/product-concept.md`。

## Accessibility Baseline

- **Accessibility tier**：`N/A` —— 内部 headless HTTP API 服务，无终端用户 UI。`design/ux/surface-profile.md`（Approved design classification）明确："No visual identity, accessibility UI requirements or prototype screen is applicable."
- **Source**：`../../design/ux/surface-profile.md`；无 `design/accessibility-requirements.md`（WCAG 针对人类感官/感知的 web 内容，不适用于 Bearer-auth JSON/HTTP API 面）。
- **Open risks**：MVP 无；若未来引入 CLI 或管理/重放 GUI，按 `product-concept.md` Visual Identity（"若未来引入管理 / 重放界面，再单独设计"）单独设计可达性。

## UX Surface Summary

> 权威：`../../design/ux/surface-profile.md`（7 面）。

| Surface | Applicability | Audience | Status |
|---|---|---|---|
| Notification HTTP API | Required | 内部业务系统 | reviewed |
| Operator HTTP API | Required | 内部 operator/SRE | reviewed |
| Vendor Admin HTTP API | Required | vendor 配置管理员 | reviewed |
| Metrics / health | Required | 部署/监控面 | reviewed |
| CLI | Excluded from MVP | — | N/A |
| GUI / admin console | Excluded from MVP | — | N/A |
| SDK | Excluded from MVP（调用方使用 OpenAPI） | — | N/A |

## Scope

rc_wsman 是内部 headless 通知投递服务。WCAG / 感官意义上的可达性义务**不适用**。适用的可用性义务是 **API 契约工效学**：稳定版本化错误、幂等 submit-and-forget（`202`）、sanitized 异步状态查询、preview-then-execute、partial-batch 结果（每输入索引恰出现一次于 `succeeded`/`skipped`/`failed`）、enumeration-safe 错误、OpenAPI/runbook 文档清晰。见 `../../design/ux/interaction-patterns.md`（7 模式）。

## Notes

引入 CLI / GUI 或新增 surface 时更新本文件；同步 `../../design/ux/surface-profile.md`。
