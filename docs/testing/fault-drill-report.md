# B6 故障演练报告 — 2026-07-22

> 隔离环境：Compose project `rcwsman_b6_acceptance`；PostgreSQL 18.4；app 端口 58080。
> 本报告记录真实运行结果，不代表生产 RPO/RTO。

## 最终结果

2026-07-22 07:46:31 UTC 执行最终版 `scripts/acceptance/faults.sh`，结果 `PASS`：

- vendor stub 收到请求后，实际 Runner 进程在 Store 结果提交前以 exit 88 终止；原通知仍存在。
- 两个独立 repository/recovery 实例竞争 advisory lock，恰有一个实例恢复 lease。
- 替代 Runner 完成第二次发送与结果提交；允许重复，并验证
  `claimed -> recovery -> claimed -> outcome` append-only history。
- 一条 `vendor-demo` notification 在 PostgreSQL 停止期间变为 eligible；数据库停止时 readiness 为
  503。启动数据库前暂停同一个 app 进程，恢复库后确认该行仍为 `pending|0|0`（零 attempt history），
  随后解除暂停；同一个 app 进程恢复 readiness=200，并将该行收敛为
  `dead|0|vendor_unavailable|claimed,outcome`。disabled fixture 保证该路径无外部网络 I/O。
- app 收到有界关闭后 exit 0，日志顺序包含 `http_server_shutting_down` 后的 `server_stopped`；重启后 readiness 为 200。

机器摘要：

```text
FAULT_DRILL_PASS started_at=2026-07-22T07:46:31Z project=rcwsman_b6_acceptance crash_after_send=runner_process_exit_88 duplicate=allowed recovery_instances=2 db_down_readiness=503 db_outage_notification=pending|0|0 db_recovered_readiness=200 db_resumed_notification=dead|0|vendor_unavailable|claimed,outcome shutdown_exit=0
```

本次最终执行直接通过；过程中 readiness 轮询在 app 刚重启时收到一次空响应，脚本继续按有界轮询
等待，并只在 readiness 明确返回 200 后判定恢复成功。

## 修正回合记录

- 较早一次 app 重启因 PITR fixture 的合法 `NULL credential_ref_version` 暴露 repository 扫描缺陷而
  fail closed；读取路径改为将可选 NULL 映射为空版本，并新增真实 PostgreSQL 回归。
- 06:14:56 UTC 版本已通过 crash、readiness 与 shutdown，但只断言数据库恢复为 200，不能证明 pending
  notification 的 claim/处理闭环。独立复审将其列为 blocker；07:46:31 UTC 最终复验使用加入上述
  outage fixture、同进程 pause/unpause 和状态/history 断言后的脚本并通过。

## 复现

```bash
COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance DB_PORT=55432 APP_PORT=58080 \
  PROMETHEUS_PORT=59090 docker compose --env-file deploy/local.env.example up --build --detach --wait
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance \
  DB_PORT=55432 APP_PORT=58080 PROMETHEUS_PORT=59090 scripts/acceptance/faults.sh
```
