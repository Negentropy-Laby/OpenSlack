# 隔离验收脚本

这些脚本只面向一次性 Compose 验收环境，不得指向生产或开发共享数据库。三个脚本都要求
`RUN_DESTRUCTIVE_ACCEPTANCE=1`，并验证 Compose project/container 名称属于 acceptance 命名空间。

先启动隔离环境：

```bash
COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance DB_PORT=55432 APP_PORT=58080 \
  PROMETHEUS_PORT=59090 docker compose --env-file deploy/local.env.example up --build --detach --wait
```

故障演练包含实际 crash-after-send 子进程、两个 recovery 实例竞争、PostgreSQL 停止/恢复和 app
有界关闭/重启：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/faults.sh
```

secret/payload marker 扫描覆盖日志、metrics、API、attempt/audit、operator projection 和验收制品：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/marker-scan.sh
```

PITR 演练：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance scripts/acceptance/pitr.sh
```

PITR 脚本在 `/tmp` 和临时 Docker volume 中完成 PostgreSQL 18.4 physical base backup、WAL 归档、
固定 `age v1.3.1` archive SHA-256 校验、加密、隔离恢复、业务不变量与 append-only guard 校验，并在
退出时清理临时恢复资源。源 Compose volume 不会被删除。运行主机需提供 Docker、curl、tar 和
sha256sum。

真实运行摘要见 `docs/testing/fault-drill-report.md`、`docs/testing/marker-scan-report.md` 与
`docs/testing/pitr-report.md`。
