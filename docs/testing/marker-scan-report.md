# Secret/Payload Marker 扫描报告 — 2026-07-22

2026-07-22 在 migration `8:false` 的隔离 Compose project `rcwsman_b6_acceptance` 执行
`scripts/acceptance/marker-scan.sh`，结果 `PASS`。

脚本为本轮生成唯一 marker，只把 marker 的 SHA-256 写入结果；原值不会写入验收制品。扫描覆盖：

- app logs、`/metrics` 和 API response；
- PostgreSQL attempt/audit；
- operator projection 与 Store log capture；
- `docs/testing` 验收制品。

机器摘要：

```text
MARKER_SCAN_PASS project=rcwsman_b6_acceptance marker_sha256=c975f7d7062789da09ba06560b680a0f5399e2156739b2c8b9c44392cd8f9b42 surfaces=app_logs,metrics,api,attempts,audit,acceptance_artifacts,operator_projection,store_logs
```

同时执行真实 PostgreSQL 集成测试
`TestSensitiveMarkerIsExcludedFromAttemptsAuditLogsAndOperatorProjections`，结果通过。扫描不能证明任意
未来日志 sink 都安全；新增 sink 或 projection 时必须扩展同一 fail-closed marker 集合。

复现命令：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/marker-scan.sh
```
