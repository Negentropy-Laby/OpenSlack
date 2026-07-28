---
schema: openslack.document.v1
id: docs-zh-cn-guide
status: In Review
authority: index
audience:
  - all
owner: project-governance
updated: 2026-07-28
sources:
  - docs/README.md
  - memory_bank/README.md
---

# OpenSlack 中文导览

英文文档是权威正文。本页只说明团队如何找到正确文档，不复制会变化的
项目状态、任务列表或发布门禁。

## 从哪里开始

- 使用产品：阅读 `README.md` 与 `docs/user/README.md`。
- 参与开发：阅读 `AGENTS.md`、根 `memory_bank/README.md`、
  `design/cdd/module-index.md` 和 `docs/architecture/control-manifest.md`。
- 查看整个项目进度：读取根 Memory Bank 的生成状态与路线图。
- 查看某个模块的运行成熟度和测试计数：读取 `docs/status/current.md`。
- 查看实际任务认领、PR、审核与交付：以 GitHub/OpenSlack 证据为准。

## 文档分层

- T0：项目法律、组合状态、发布状态。
- T1：架构、技术、UX、QA 与知识关系。
- T2：计划分配、工作流契约与生成路线图。
- T3：门禁、评审、发布、QA 和修订证据索引。

## 更新规则

不要直接编辑生成的 Markdown。先修改对应 YAML，再运行：

```bash
bun run docs:generate
bun run docs:verify
bun run docs:migration-check
```

根 Memory Bank 面向整个项目和所有开发者；`.openslack/` 中的本地文档或
状态仍属于单一开发者/运行时工作区。
