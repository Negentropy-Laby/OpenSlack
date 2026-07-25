# Notification Delivery Canary deployment pack

本目录定义 IB4/IB5 的单主机 Canary override；它与仓库根
`docker-compose.yml` 一起使用，不包含真实 resource ID 或 secret。根 Compose
仅提供服务拓扑；本 override 会删除根配置中的固定 PostgreSQL 身份、demo vendor
token、外部数据库端口和本地 app build。

## Fail-closed preflight

部署系统必须把 protected environment 的值写入 host-local、owner-only、
mode-`0600` env file。不得 source 该文件，也不得运行会渲染 Compose config 到
stdout 的命令。先执行：

```bash
deploy/canary/preflight.sh \
  --env-file /srv/openslack-notification-canary/runtime.env
```

preflight 使用非执行型 dotenv parser，拒绝 unknown/duplicate key、CRLF、
placeholder、symlink、非 owner `0600` 文件、固定数据库 identity/URL 不一致、
非 HTTPS/443 origin、混合 image mode 和不闭合的 Compose config。输出只包含
稳定 result code 和 mode，不回显任何 value。

`CANARY_POSTGRES_PASSWORD` 必须是至少 32 个字符的 URL-safe random value；
`CANARY_DATABASE_URL` 必须使用相同 user/password/database，并仅在隔离 Compose
网络内使用 `db:5432`。数据库不发布 host port。app、Prometheus 与 receiver
只发布到 `127.0.0.1`。

## Authoritative pinned-image mode

真实 G4/G5 必须使用：

```text
CANARY_DEPLOYMENT_MODE=pinned-image
NOTIFICATION_SERVICE_IMAGE=<registry/repository>@sha256:<digest>
CANARY_WEBHOOK_RECEIVER_IMAGE=<registry/repository>@sha256:<digest>
```

preflight 要求两个 image 都由 digest 固定，并要求 service image 的 digest
与 `NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST` 完全一致。验证通过后启动：

```bash
docker compose \
  --env-file /srv/openslack-notification-canary/runtime.env \
  -f docker-compose.yml \
  -f deploy/canary/docker-compose.yml \
  -f deploy/canary/docker-compose.pinned.yml \
  config --quiet

docker compose \
  --env-file /srv/openslack-notification-canary/runtime.env \
  -f docker-compose.yml \
  -f deploy/canary/docker-compose.yml \
  -f deploy/canary/docker-compose.pinned.yml \
  up --detach --wait
```

禁止为此路径增加 `--build`，也禁止 tag-only image。部署 manifest 记录两个
完整 image references 与 `docker image inspect` 得到的实际 RepoDigest。

## Verified local-build rehearsal

`verified-local-build` 只用于 G4 前的主机/Compose 预演，不能关闭 G4/G5。env
file 不得包含两个 remote image key，必须包含 clean checkout 的 exact
`CANARY_SOURCE_COMMIT` 与 `CANARY_SOURCE_TREE`。deployment digest 固定为：

```text
SHA-256(
  "rc_wsman.canary.local-build.v1" || NUL ||
  source_commit                    || NUL ||
  source_tree
)
```

preflight 会重算 commit、tree、clean-worktree 与 digest。随后显式使用 local
overlay；build context 由首个 Compose 文件固定为 repository root：

```bash
docker compose \
  --env-file /srv/openslack-notification-canary/runtime.env \
  -f docker-compose.yml \
  -f deploy/canary/docker-compose.yml \
  -f deploy/canary/docker-compose.local-build.yml \
  up --build --detach --wait
```

两个 local image 带有 revision/tree/mode labels，run manifest 必须记录
`docker image inspect` 的 image ID 与 labels。任何 dirty checkout 或 source
不匹配都会 fail closed。

## TLS/443 reverse proxy boundary

Go service 和 receiver 只提供 host-loopback cleartext listener，不直接面对
外网。部署方必须在独立 reverse proxy 上：

1. 仅对外开放 TCP 443；
2. 使用受信任 CA 证书和原 hostname TLS validation；
3. 将 `CANARY_SERVICE_ORIGIN` 转发至 `127.0.0.1:${APP_PORT}`；
4. 将 `CANARY_WEBHOOK_ORIGIN` 转发至
   `127.0.0.1:${WEBHOOK_RECEIVER_PORT}`；
5. 禁止 HTTP redirect、public 8080/8090 和 proxy access/body logs。

两个 origin 只允许 `https://DNS-name` 或显式 `:443`，不得含 userinfo、
path、query、fragment 或其他 port。G4 开始前必须从 OpenSlack host 通过
两个 external origin 验证有效 TLS chain、hostname、`/health/version` 与
`/health/ready`；loopback health 不能替代此证据。

## Receiver storage and verification

`WEBHOOK_RECEIVER_EVIDENCE_DIR` 必须由部署方预创建为 UID/GID
`65534:65534`、mode `0700` 的专用目录；不得指向 repository、home 或共享
目录。

receiver vendor POST endpoint 是 `/v1/receive`。它只在内存中计算 body
SHA-256，随后丢弃 body；持久层仅保存 request ID、两个 idempotency header、
digest、size 与接收时间。查询 endpoint
`GET /v1/records?idempotency_key=...` 要求
`Authorization: Bearer <WEBHOOK_AUDIT_TOKEN>`，原始 token 不得写入命令行、
日志、PR 或 evidence。持久化记录的 closed contract 位于
[`webhook-record.schema.json`](webhook-record.schema.json)。

部署后必须先核验：

```text
GET external service origin /health/version -> 200, ready=true, expected digest
GET external receiver origin /health/ready  -> 200, ready=true
receiver unauthenticated query              -> 401
public 8080/8090 and database port           -> unreachable
```

真实 Slack channel、两个 vendor ID、host/origin 与 key 只记录在 D4-0
deployment manifest；本目录保持参数化。
