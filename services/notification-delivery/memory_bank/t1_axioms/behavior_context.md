# Behavior Context

> T1 supporting context。项目协作行为（非运行时状态机）。
> 来源：外部 Constitution-Driven-Development framework collaboration protocol；
> rc_wsman 本地未安装完整 CDD runtime。

## Collaboration Protocol

重大变更遵循 **Question → Options → Decision → Draft → Approval**。
- 写入文件前展示精确 draft / diff 并取得批准。
- 多文件变更须显式批准完整 changeset。
- 无用户指令不提交代码。

## Repository Truth

| Topic | Current status |
|-------|----------------|
| Version control | **Not initialized** — rc_wsman 当前不是 Git 仓库 |
| Primary branch | Not initialized（Git 初始化后采用 main / trunk-based） |
| Feature workflow | Not initialized |
| Commit policy | 无用户指令不提交 |

> 不得声称 primary branch 已经是 main；Git 初始化后再确定分支策略。

## Review Rules

- 模块 CDD 必须经过独立 `/design-review --depth lean`（new session）。
- Review mode：lean（per-run；repo 级 `review-mode.txt` 未建）。
- 不在本仓库自评本会话产出的 CDD。

## Definition of Done

artifact 存在 + AC 可测（GIVEN-WHEN-THEN）+ 独立 review evidence + 所需 phase gate PASS。

## Decision Evidence

- T0 current state：`../t0_core/current_state.md`、`../t0_core/active_context.md`
- CDD review logs：`../../design/cdd/reviews/`
- T3 indexes：`../t3_archive/`
