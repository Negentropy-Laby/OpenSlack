# OpenSlack 外置 DeepSeek Harness 插件

本插件由 OpenSlack 所有，包名为 `@openslack/deepseek-harness-plugin`。
首轮固定兼容未修改的 Harness
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`、SDK/dsh `0.2.1-rc.3`
及 Node `24.18.1`。不修改 Harness 源码、SDK、MCP、锁文件或默认配置，
不增加 Harness application bin，不依赖旧实验工作树的补丁和产物。

## 构建和安装

先在原版依赖副本中安装锁定依赖、构建原版产物。不得复制旧实验的
`node_modules`、`lib`、身份或凭据。从 OpenSlack 根目录运行：

```sh
export DEEPSEEK_HARNESS_CHECKOUT=/原版已构建Harness的绝对路径
bun run build
bun integrations/deepseek-harness/build.mjs
bunx vitest run integrations/deepseek-harness
```

外置包有独立类型检查，只依赖公开声明。运行时 peer 不打入包内；必须复用获准
Harness 安装中的同一套 Cordis、Tools、FS 和 SDK。依赖缺失、不匹配或部署
摘要不符时拒绝启动。测试同样要求显式指定依赖，不会静默换成 SDK 模拟器。

本地打包而非发布：

```sh
cd integrations/deepseek-harness
npm pack --ignore-scripts --pack-destination /归档输出绝对路径
```

实施完成后，由部署维护者对既有获准 home 使用原版正式插件安装机制：

```sh
DSH_HOME=/获准home dsh plugin --profile sdk add /插件归档绝对路径.tgz --offline --ignore-scripts
```

安装只增加默认禁用的 `openslack-readonly` 配置行，不启动连接、不启用工具、
不创建身份或凭据、不批准任务。部署方用每次启动的 overlay 显式启用并配置。
Windows 原生与 WSL 分别使用实际本地路径及既有 home，凭据仍由 Harness 原服务管理。

## 入口与严格边界

| 入口 | 用途 |
| --- | --- |
| 包根 | worker：精确文件授权、本任务 report、本运行查询 |
| `/initiator` | 派发一个已批准任务，仅查询返回的运行 |
| `/readonly` | 原有十二个只读 MCP 工具 |
| `/sdk-host` | 公开 SDK Server 的宿主授权与关闭协调组合 |

私有 `dist/startup.js` 是 Bridge 启动产物，不是模型工具或新 application bin。
OpenSlack 绑定原版 Harness、插件、Node、overlay、模型和验证器摘要。
只允许两个批准代码根中的确定公开文件，不放行任意目录；模型不能选择这些路径。
`.build/fixtures` 中的脚本模型仅用于测试，不进入归档。

SDK-host 与只读配置还包含 `runtimeEntries`：由宿主
`harnessPublicRuntimeEntries()` 产生的精确公开 ESM 映射序列化值。
宿主启动前拒绝物理 peer 覆盖，SDK host 创建 Server/MCP 前再用实际公开解析器
核对映射。外部 SDK client 另从批准包锚点解析，不在插件内安装第二份运行时。

启动 overlay 禁用原 `sdk-jsonrpc-server`，改挂外置 `/sdk-host`；只有一个 STDIO
server，标准协议委托公开 `HarnessSdkJsonRpcServer` 和 `JsonRpcLineTransport`。
不访问 SDK 私有字段，不 monkey-patch。实际子进程通过 Node 公开但实验性的
`child_process` 诊断通道观察；不能观察时不得把退出视为成功。

原始 MCP 写定义只在连接 owner 内，模型只见作用域包装。真实确认令牌仅存内存，
confirm/cancel 只接受 plan ID，不落入模型、Session、transcript 或证据。
worker 不能递归派发；文件动作前实时宿主授权，原 FS 版本守卫继续生效。
断线立即使能力失效，不自动重连或重新执行。

## 终态、恢复与资格

dispatch 的完成仅代表持久 pending 受理；同任务同摘要返回原运行，输入漂移拒绝，
未知受理不重派。report 不能声明完成或验收。

成功必须依次获得 Session/托管工作结束、代际绑定的 prepare-shutdown、MCP 停止
收据、标准 ACK、直接观察到 SDK code=0/无 signal/未请求终止、peer 退出，最后
由宿主核验基线、范围、输出、字节与证据。`prompt()`、idle、心跳、发信号、ACK
或单独 exit 0 均不足。初始化失败、强制终止、disposer 失败及未知副作用不得成功。

原调用方通过既有 `openslack_get_activity({objectKind: 'workflow', objectId: runId})`
读回同一运行。恢复仅核对，不 prompt、自动 resume、创建替代 Session 或重派；
保留工作树、原始字节和证据。

无凭据脚本模型测试不替代真实主体/模型联调、Windows 原生、托管 CI 或人工验收。
实际部署参数在实现后提供。禁止批准、合并、发布、身份 bootstrap 及触及 #415/#425。

图标与 MIT 许可来自 DeepSeek Harness；运行时代码通过公开包复用，不复制进插件。
详见 [LICENSE](./LICENSE)、[英文说明](./README.md)及
[架构说明](../../docs/architecture/components/agent-runtime.md)。
