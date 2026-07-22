# 物理备份与 PITR 演练报告 — 2026-07-22

> 仅使用隔离 Compose volume；未启动恢复环境的 Delivery，也未向真实供应商发送请求。本次测量不承诺
> 生产 RPO/RTO。

## 最终结果

固定 PostgreSQL 18.4、固定 `age` v1.3.1 archive SHA-256，在临时 volume 中完成 physical base
backup、WAL archive、age 加密导出/解密和 target-time recovery，最终结果 `PASS`：

```text
PITR_PASS age=v1.3.1 target_time=2026-07-22 07:48:34.324828+00 archived_wal=000000010000000000000006 markers=before,target schema=6:false fixture=pitr-20260722t074830z-4633 invariants=notification,vendor_version,audit,access_key,attempt_append_only
```

恢复目标只包含 `before,target` marker，不包含 target 之后的 `after`。除 migration version 6/clean 外，
脚本逐字段验证 fixture 的 notification 状态与不可变材料、attempt 次序、vendor/current endpoint
version、admin receipt/audit、access-key status/pepper/hash；随后实际尝试更新 delivery attempt，并确认
append-only trigger 拒绝更新。

## 运行中的失败记录

- 初版从 `age-keygen` stderr 提取 recipient，出现临时文件缺失并 fail closed；已改为从 identity 文件
  确定性派生 recipient。
- 随后的两次 Go module 下载分别在 module proxy 与 checksum service 遇到 EOF，均未记为成功；脚本改为
  下载官方 v1.3.1 release archive，并在执行前校验固定 SHA-256。

失败运行都由 cleanup trap 删除临时 restore container/volume 与源 acceptance 容器内的临时 basebackup
目录；未触碰非 acceptance 数据库卷。

复现命令：

```bash
RUN_DESTRUCTIVE_ACCEPTANCE=1 COMPOSE_PROJECT_NAME=rcwsman_b6_acceptance scripts/acceptance/pitr.sh
```
