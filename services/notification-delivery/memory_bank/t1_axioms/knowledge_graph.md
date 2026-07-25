# Knowledge Graph

> T1 supporting context。模块/实体依赖与数据流的索引层；不替代 `../../design/cdd/module-index.md` 或
> `../../design/registry/entities.yaml`（权威源）。

## Core Dependency Chain

投递主链（`../../docs/architecture/architecture.md` Inbound/Delivery Flow）：

```text
intake（dedup + immutable body/fingerprint + outbox 可见性，单事务）
  -> worker 认领最老 eligible 行 + lease（FOR UPDATE SKIP LOCKED）
  -> pre-send attempt/deadline 检查 -> latest active snapshot（Vendor Registry）
  -> 内存解析 credential -> 构造 headers/body
  -> 解析全部 A/AAAA + 策略校验 -> dial 单个 pinned IP + 原始 TLS hostname -> 单次 HTTP
  -> 分类 response/transport result -> 原子 Store transition（succeed / retry / die）
  -> retryable @/after cycle_send_cutoff => die(permanent_failure, deadline_exceeded)（CTRL-006）
  -> no-send cutoff => 非计次 policy_termination（CTRL-007）
  -> dead => 人工重放（Operations Control：preview-first / version-checked / explicit）
```

管理写链（`architecture.md` Persistence and Transactions）：

```text
operator admin command -> Caller Access 鉴权 -> idempotency receipt 查找 (actor_id, idempotency_key)
  -> vendor mutation + 可选 version append + audit event + receipt（单事务）
  -> admin_audit_events（append-only，全局 audit_seq，禁 credential locator/secret/command fingerprint/raw caller）
```

## Module Dependency Map

> 权威：`../../design/cdd/module-index.md`（6 模块 / 5 边 / DAG / 最长链 L0→L1 / 无环）。

| Module | Layer | Depends On | Depended By | Status |
|---|---|---|---|---|
| Notification Store | 0 | — | Delivery、Operations Control、Reliability Observability | stable（Approved） |
| Vendor Registry | 0 | — | Delivery | stable（Approved） |
| Caller Access | 0 | — | Operations Control | stable（Approved） |
| Delivery | 1 | Vendor Registry、Notification Store | — | stable（Approved） |
| Operations Control | 1 | Notification Store、Caller Access | — | stable（Approved） |
| Reliability Observability | 1 | Notification Store | — | stable（Approved） |

- **反向依赖计数**：Notification Store = 3（瓶颈，状态核心）；Vendor Registry = 1；Caller Access = 1；其余 = 0。
- **已移除边**：Reliability Observability → Delivery（MVP 三指标均 Store 派生；per-vendor 错误率为 v1+ 演进）。
- **安全方向（已验证）**：调用方不能绕过 Caller Access（`caller_id` 为已验证输入）；Delivery 不能绕过已批准 vendor 策略（→ Vendor Registry）；重放不能绕过状态 + 授权（Operations Control → NS + CA）。

## Integration Points

> 内部 port 形状（`architecture.md` Internal Interfaces）+ 实体 referenced_by（`../../design/registry/entities.yaml`）。

- **Store port**：`Accept(ValidatedIntake)` / `Claim(leaseTTL)` / `Transition(TransitionRequest)` / `RecoverExpired(limit)` / `Query(StoreQuery)` —— 被 Delivery（claim/transition）、Operations Control（query/transition(replay)）、Reliability Observability（global query）、App（recover）消费。
- **VendorRegistry port**：`IsActive(vendorID)`（ingress）/ `SnapshotLatest(vendorID)`（Delivery）/ `Admin(AdminCommand)`（operator）。
- **ValidatedIntake**：caller-access + architecture 引用；ingress 组合产出，Store 消费。
- **Notification / DeliveryAttempt / TransitionRequest / DeliveryResult**：Delivery、Operations Control、Reliability Observability 跨引用；`DeliveryResult` 分类权威归 `../../design/cdd/delivery.md`，持久化归 Store。
- **DeliveryConfigSnapshot**：Delivery + adr-0004 引用；Vendor Registry 产出。
- **ActorContext**：Store 与 VendorRegistry 各有特化契约；Delivery / Operations / RO 引用。
- **AdminAuditEvent**：Vendor Registry 拥有（`admin_audit_events`，全局 `audit_seq`，sanitized；禁 credential locator/secret/command fingerprint/raw caller）。

## Notes

模块边界或实体依赖变化时更新本文件；同步 `../../design/cdd/module-index.md` 与 `../../design/registry/entities.yaml`。
