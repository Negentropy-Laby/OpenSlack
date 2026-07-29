---
schema: openslack.document.v1
id: evidence-notification-constitution-v1
status: Archived
authority: archive
audience:
  - reviewers
owner: notification-delivery
updated: 2026-07-29
sources:
  - services/notification-delivery/design/cdd/product-concept.md
  - services/notification-delivery/docs/architecture/adr-registry.yaml
---

# Notification Delivery Amendment v1.0 — Constitution Accepted

> 宪法从 0.1 Draft 升级为 1.0 Accepted 的正式修订证据。
> 原服务级 Memory Bank 记录已规范化迁入唯一的根 Memory Bank；原路径可通过 Git 历史恢复。
> 日期：2026-07-18。

## 1. 触发

项目所有者在草案 v0.1（rev 2）多视角审查后完成核验，给出三项架构定夺与一项签发前阻塞
修订，并批准 BL-01..BL-06、升级宪法为 v1.0 Accepted。

## 2. 法律变更（basic_law_index.md）

- **BL-02**：
  - 增 **幂等冲突规则** —— 持久化不可变 `request_fingerprint`；相同 `(caller_id,
Idempotency-Key)` 且指纹一致 → 返回原 `notification_id`；指纹不同 → 返回
    `409 IdempotencyConflict`，不创建任务、不复用旧结果（防止错误复用 key 静默吞掉合法通知）。
  - 增 `caller_id` **服务端推导**约束 —— 不接受请求 Header/Body 自报。
  - 新增第三条 design test（同键异指纹 → 409）。
- **BL-05**：
  - SSRF 绑定升级 —— 默认禁止所有非公网地址（IPv4/IPv6）；vendor 显式
    `hostname + port + CIDR` 例外；**DNS pinning**（连接前校验 A/AAAA）；**默认不跟随重定向**。
  - 完整 CIDR 清单 / 解析算法 / 重定向策略移至 ADR / T1，不膨胀 T0。
- **BL-01..BL-06**：Status 由 Proposed 升为 Accepted (2026-07-18)。

## 3. 已批准架构决定（进 ADR / T1，非 T0 法律）

按所有者定夺，以下决定**不写入 T0 法律**，仅在 `active_context.md` 登记为已批准架构决定，
细节随后进 ADR / T1：

1. **存储 = PostgreSQL**（BL-03 仍只绑定 outbox 模式 + 单事务原子性）
   - worker 用 `FOR UPDATE SKIP LOCKED` 取任务（[PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html)）。
   - SQLite 不作并发 worker 生产替代；MySQL 可行但无足够收益保留双实现。
   - `/setup-engine` 后续只选语言 / 框架 / 驱动 / 版本，不再重选数据库。
2. **调用方认证 = API Key（MVP）**
   - `caller_id` 服务端推导，仅存哈希，日志只记 key ID / caller ID；支持撤销 / 轮换 /
     `vendor_id` 权限范围；强制 TLS + 调用方级限流。
   - **不视为高价值生产接口的唯一长期防线**；接入统一 IdP / 服务网格后演进为 JWT/OIDC / mTLS
     （[OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)）。
3. **SSRF 完整策略**
   - IPv4 私网 / 回环 / 链路本地 / 组播 / 保留默认禁；IPv6 回环 / 链路本地 / ULA / 组播 /
     非全局默认禁；企业内网供应商按 vendor 显式批准；配置写入与连接前双重校验 A/AAAA；
     默认禁跟随重定向；不只检查字符串或单点 `169.254.169.254`
     （[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)）。

## 4. 文档维护变更

- `release_state.md`：删除不适用于本项目的 `CLI` 测试类型（改为 contract / integration /
  migration）。
- `active_context.md`：PostgreSQL 从"候选架构"升为"已批准架构决定"；新增 Constitution
  Changelog 与 Amendment Sign-Off 块。
- `current_state.md`：阻塞从"宪法待 sign-off"转移到"T1 axioms / ADR / 设计文档未建立"。

## 5. 相关证据

- 草案审查（含用户核验反馈）：`memory_bank/t3_archive/reviews/review-index.md` 的 Notification Delivery constitution 条目
- 宪法正文：`memory_bank/t0_core/basic_law_index.md` 的 ND-BL-01..06
