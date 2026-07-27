# 目标架构

```text
MES / QMS read-only snapshots
            |
            v
OpenSlack Workflow -> governed Agent Runtime
            |
            v
GitHub Issues / draft PR / PRMS
            |
            v
Business outcome projection
```

## 控制

- 六个固定 `agentType`，每次调用均使用结构化输出和 token 预算。
- Workflow 本身不创建 Issue、PR，不执行 Approval、Merge 或 main 写入。
- live rehearsal 的 GitHub 对象由显式 `--execute` 路径创建；Issue 固定使用 GitHub App 身份，PR 固定使用 governed delivery。
