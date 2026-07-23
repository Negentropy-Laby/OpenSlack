# Notification Delivery Canary deployment pack

本目录只定义 IB4/IB5 的单主机 Canary override；它与仓库根
`docker-compose.yml` 一起使用，不包含任何真实 resource ID 或 secret。

部署系统必须先把 protected environment 中的值写入主机上的 `0600`
env file，并确认 `NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST` 是已经验证的
OCI image digest。`WEBHOOK_RECEIVER_EVIDENCE_DIR` 必须由部署方预创建为
UID/GID `65534:65534`、mode `0700` 的专用目录；不得指向 repository、
home 或共享目录。启动命令：

```bash
docker compose \
  --env-file /srv/openslack-notification-canary/runtime.env \
  -f docker-compose.yml \
  -f deploy/canary/docker-compose.yml \
  up --build --detach --wait
```

`webhook-receiver` 的 vendor POST endpoint 是 `/v1/receive`。它只在内存中
计算 body SHA-256，随后丢弃 body；持久层仅保存 request ID、两个
idempotency header、digest、size 与接收时间。查询 endpoint
`GET /v1/records?idempotency_key=...` 要求
`Authorization: Bearer <WEBHOOK_AUDIT_TOKEN>`，原始 token 不得写入命令行、
日志、PR 或 evidence。持久化记录的 closed contract 位于
[`webhook-record.schema.json`](webhook-record.schema.json)。

部署后必须先核验：

```text
GET service /health/version     -> 200, ready=true, expected deployment digest
GET receiver /health/ready     -> 200, ready=true
receiver unauthenticated query -> 401
```

真实 Slack channel、两个 vendor ID、host/origin 与 key 只记录在 D4-0
deployment manifest；本目录保持参数化。
