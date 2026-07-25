# 本地容量基线 — 2026-07-22

> 这是当前机器的一次工程测量，不是 SLA，也不推导生产 RPO/RTO。

## 环境与参数

| 项 | 实测值 |
|---|---|
| CPU / memory | x86_64，16 vCPU，31 GiB RAM |
| Go | 1.26.5 linux/amd64 |
| PostgreSQL | 18.4，Debian 18.4-1.pgdg13+1 |
| Docker client/server | 28.0.1 / 28.0.1 |
| Worker 并发 | W=5 |
| 样本 | 1,000 × 1 KiB；100 × 256 KiB |
| vendor latency | 本轮只测进程内成功结果写回；未模拟公网延迟 |

## 实测结果

| 路径 | p50 | p95 | p99 | 总耗时 |
|---|---:|---:|---:|---:|
| 1 KiB intake（1,000） | 1.422 ms | 1.935 ms | 2.652 ms | 1.489 s |
| 256 KiB intake（100） | 5.045 ms | 5.517 ms | 6.192 ms | 0.509 s |

W=5 对 1,100 条 notification 执行 claim + 成功结果事务写回，用时 1.544 s，当前基线约
712.4 条/秒。完成后 outbox 投影为 pending=0、in_flight=0、delivered=1,100、dead=0、oldest age=0。
claim 查询计划使用 `notifications_eligible_idx` 的 Index Only Scan，再做 incremental sort。

| relation | table before | table after | index before | index after |
|---|---:|---:|---:|---:|
| notifications | 0 B | 3,129,344 B | 49,152 B | 909,312 B |
| delivery_attempts | 0 B | 466,944 B | 24,576 B | 581,632 B |

本轮 1,100 条样本对应索引增长分别为 notifications 860,160 B、delivery_attempts 557,056 B；
这些是 disposable schema 的一次测量，不外推长期膨胀率。

该数值包含同机 PostgreSQL 与测试进程，不包含真实供应商网络往返。因此它只回答本地 Store
transactional path 的量级，不代表端到端通知吞吐。

## Deadline backlog 矩阵

- Path A（发送前已到 cutoff）：在真实 PostgreSQL schema 中以 W=5 处理 N=1、5、10、25、50、
  100、200、500；全部以一次不计数 `policy_termination(deadline_exceeded)` 结束，发送数为 0，
  每条恰有 `claimed,outcome` 两条 append-only history，第二次 claim 为空。对应处理时间为
  6.8、34.6、38.1、47.9、72.9、130.3、293.3、653.9 ms。
- Path B（cutoff 前全部进入发送、cutoff 后同时释放 503）：N=1、5、10、25 全部保留 actual HTTP
  503，以一次计数的 `die(deadline_exceeded)` 结束，无 `next_attempt_at`；PostgreSQL 中逐条验证
  `attempt_count=1`、`dead_at <= delivery_cycle_started_at+24h`、两条 history、第二次 claim 为空。
  对应等量并发处理时间为 7.6、39.9、52.9、68.2 ms。
- blocking 点 N=1 与 N=W=5 均通过。Path A 在 N≤500、Path B 在 N≤25 未观察到结构性突破点；
  更高 N 和带真实 vendor latency 的结果属于 Evolution Boundary，不能由本轮推断。

可复现命令：

```bash
RUN_CAPACITY_BASELINE=1 go test ./tests/integration -run '^TestCapacityBaseline$' -count=1 -v
go test -race ./tests/integration -run '^TestDeadlineBacklogPostgresMatrixPersistsInvariants$' -count=1 -v
```
