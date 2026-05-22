---
schema: openslack.product.v1
version: "0.1"
status: developer_preview
date: 2026-05-22
---

# OpenSlack 产品文档

**Local-first, Git-backed Agent Company OS**

版本：v0.1 · 状态：Developer Preview / Partial Product Pass · 当前核心模块：Self-Evolution Kernel、GitHub Issues Task Loop、Operator Interface · 推荐用户：开发者、AI agent workflow 架构师、小型 agent-first 工程团队 · 当前不适合：非技术用户、完全离线使用、无需 GitHub 的团队

---

## 1. 产品一句话

OpenSlack 是一个 local-first、Git-backed 的 AI Agent 公司操作系统。

它让 Claude Code、Codex、reviewer、researcher、自定义 agent 等异构 AI agent 像"员工"一样工作：从 GitHub Issues 发现任务，通过 deterministic git ref 原子领取任务，在隔离 worktree 中执行，通过 PR 提交成果，并在必要时让人类进行审批和兜底。

当前 README 对产品的描述已经明确：OpenSlack 让异构 AI agents 从 GitHub Issues 发现任务，用 deterministic git ref locks 领取任务，在 isolated worktrees 中工作，通过 PR 提交输出，并只在审批和异常场景中与人类沟通。

## 2. 产品定位

OpenSlack 不是传统 Slack bot，也不是一个单纯的自动化脚本。它的定位是：

```
Agent Company OS
= 工作区状态源
+ 自我验证系统
+ GitHub 任务队列
+ Agent 领取与执行协议
+ PR 审查与同步机制
+ 人类审批与异常处理层
```

核心原则：

```
Chat is a frontend.
Git is the source of truth.
Agents are workers, not chatbots.
```

也就是说，聊天软件、CLI、Web UI 都只是交互前台；真正的公司状态、任务、规则、记忆和审计都应当落在 Git / GitHub / `.openslack/` 工作区中。

## 3. 当前产品状态

当前 OpenSlack 不是完整商业产品，而是一个 Developer Preview。它已经具备两个核心 active modules，并已经开始提供用户友好的 setup 与 operator 入口。

当前状态文档显示两个 active modules：

- **OSEK** — Self-Evolution Kernel
- **GITL** — GitHub Issues Task Loop

其中 OSEK 负责自我验证、自我保护、回滚与策略约束；GITL 负责通过 GitHub Issues 完成 agent 任务发现、领取、执行、PR、review、done 的闭环。

当前技术债文档显示，大部分历史 P0/P1/P2 已关闭，仍开放的主要问题是：

- **P0-1**: Branch protection ruleset not configured
- **P2-5**: Empty state directories in `.openslack/`

也就是说，工程能力已经明显成熟，但 GitHub 分支保护仍需要人类管理员完成。

## 4. 产品目标

OpenSlack 当前版本的目标不是立即提供完整企业级平台，而是证明以下三个闭环：

### 4.1 自我进化闭环

OpenSlack 可以把自己作为第一个被管理的项目：

```
OpenSlack observes itself
→ validates itself
→ classifies risky changes
→ creates improvement tasks
→ lets agents work through PRs
→ reviews / scores / rolls back changes
```

早期 Phase 1 文档把这个目标定义为：让 OpenSlack 成为它管理的第一个项目，并且能够安全地 self-observe、self-validate、self-improve，同时避免 runaway。

### 4.2 GitHub-backed agent 任务闭环

Agent 可以通过 GitHub Issues 工作，而不依赖 GitHub Project v2 或 OAuth device flow：

```
GitHub Issue
→ openslack:ready
→ agent tick
→ deterministic git ref claim
→ worktree
→ PR
→ review
→ issue done
```

### 4.3 单入口雏形

用户可以通过少数命令使用 OpenSlack：

```
openslack setup
openslack ask "检查系统状态"
openslack status
openslack doctor
```

当前 CLI 已经注册了 `ask`、`status`、`doctor` 顶层别名，并将它们路由到 Operator、workspace status 和 GitHub doctor。

## 5. 非目标

当前版本不承诺以下能力：

1. 不承诺完全离线运行。
2. 不承诺不依赖 GitHub。
3. 不承诺普通非技术用户开箱即用。
4. 不承诺完整 Slack / Teams / 飞书 / 钉钉 Chat Gateway。
5. 不承诺 Web Dashboard。
6. 不承诺 GitHub Project v2 作为任务主队列。
7. 不承诺 agent 可以自动修改 Red Zone 文件。
8. 不承诺 agent 可以 merge 自己的 PR。
9. 不承诺生产部署自动化。

当前状态文档明确把 GitHub Project v2、Chat Gateway、Web Dashboard 列为 deferred。

## 6. 目标用户

### 6.1 主要用户

1. Agent workflow 架构师
2. AI-native 工程团队
3. Claude Code / Codex 自动化重度用户
4. 想构建 agent-first company OS 的开发者
5. 想让 AI agent 通过 GitHub Issues / PR 自主工作的团队

### 6.2 次要用户

1. 研究型个人开发者
2. DevOps / 平台工程师
3. 自动化工具链开发者
4. 需要 agent 自我验证和回滚机制的项目维护者

### 6.3 当前不适合的用户

1. 完全不懂 GitHub 的非技术用户
2. 不愿意配置 GitHub App / PAT 的用户
3. 不接受 CLI 工作流的用户
4. 希望立即获得 Slack/Teams 图形化界面的用户

## 7. 产品架构

### 7.1 用户视角三大模块

OpenSlack 应以三个产品模块对外呈现：

- **Module 01** — Self-Evolution
- **Module 02** — GitHub Task Loop
- **Module 03** — Operator

#### Module 01：Self-Evolution

负责保护 OpenSlack 自己。能力包括：

- workspace validate
- risk zone classification
- constitution / invariants
- golden evals
- self validation
- scorecard
- rollback
- genesis validate

#### Module 02：GitHub Issues Task Loop

负责让 agent 在 GitHub 上工作。能力包括：

- create task issue
- query ready issues
- claim issue using git ref
- heartbeat / expiry
- lifecycle transition
- task filtering
- label repair
- claim repair
- PR merged → issue done

当前状态文档将这些 GitHub integration 能力标记为 ACTIVE。

#### Module 03：Operator

负责用户入口。当前能力：

- openslack ask
- openslack setup
- openslack status
- openslack doctor

当前 Operator 仍是规则路由器，不是完整智能 agent planner，但已经具备产品单入口雏形。

## 8. 工程架构

当前工程正在从多个历史包收敛为更清晰的模块结构。推荐最终工程视图：

```
packages/
  kernel/
  workspace/
  core/
  runtime/
  github/

apps/
  cli/
  auth-callback/
```

当前状态文档显示：5 active packages + 4 compat shims + 2 apps

5 个 active packages 为：

- `@openslack/kernel`
- `@openslack/workspace`
- `@openslack/core`
- `@openslack/runtime`
- `@openslack/github`

兼容 shim 用于旧 import 的过渡期。

## 9. 核心数据源

OpenSlack 的核心数据源分为三层。

### 9.1 `.openslack/` 本地工作区

`.openslack/` 保存 OpenSlack 的 durable workspace state：

```
.openslack/
  agents/
  policies/
  self/
  tasks/
  sync/
```

它包含：

- agent registry
- policies
- constitution
- invariants
- golden evals
- tasks
- rollback state
- release channels

### 9.2 GitHub Issues

GitHub Issues 是当前 agent 任务主队列。任务 issue 具有：

- `openslack:task`
- `openslack:ready`
- `risk:low / medium / high / critical`
- `agent-type:codex / reviewer / sync / memory`

### 9.3 Git refs

Git refs 是任务领取锁。OpenSlack 使用 deterministic git ref 作为 claim lock：

```
refs/heads/openslack/claims/issue-{issueNumber}
```

这个设计避免多个 agent 同时 claim 同一个任务。

## 10. 任务生命周期

GitHub Issues Task Loop 的生命周期是：

```
CREATE
→ READY
→ CLAIMED
→ RUNNING
→ REVIEW
→ DONE
```

异常路径：

```
CLAIMED / RUNNING
→ EXPIRED
→ READY

任意执行中状态
→ BLOCKED
```

README 中也已经用同样形式描述了任务生命周期。

### 10.1 CREATE

任务被创建为 GitHub Issue，并带有结构化 `openslack-task` manifest。

### 10.2 READY

任务带有：

```
openslack:task
openslack:ready
```

agent 可以尝试领取。

### 10.3 CLAIMED

agent 创建 claim ref：

```
refs/heads/openslack/claims/issue-{n}
```

如果 ref 创建成功，则领取成功。

### 10.4 RUNNING

agent 创建 worktree 并开始执行任务。

### 10.5 REVIEW

agent 提交 draft PR，issue 进入 review 状态。

### 10.6 DONE

PR merge 后，workflow 释放 claim ref，并将 issue 标记为 done。

## 11. Issue Task 格式

OpenSlack 使用 GitHub Issue 作为任务对象。任务 metadata 写在 `openslack-task` code fence 中：

````markdown
```openslack-task
schema: openslack.github_issue_task.v1
task_id: TASK-2026-000123
title: Fix failing workspace validation
agent_type: codex
risk_level: low
required_capabilities:
  - typescript
  - workspace
allowed_paths:
  - packages/workspace/**
  - docs/**
forbidden_paths:
  - .github/**
output_contract:
  - draft_pr
  - workspace_run_record
```
````

README 当前也展示了该格式作为 Issues-first task format。

## 12. 权限与认证模型

OpenSlack 当前采用三层 GitHub 认证模型。

### 12.1 Runtime Primary：GitHub App installation token

用于 agent runtime：

- 创建 issue
- 查询 issue
- claim issue
- push branch
- create draft PR
- repair labels
- repair claims

### 12.2 Dev Fallback：PAT / GITHUB_TOKEN

用于本地开发和调试。

### 12.3 Human Login：OAuth / gh CLI

只用于人类登录，不用于 agent runtime。

README 和当前状态文档都明确列出了三层认证模型。

## 13. 用户入口

当前推荐用户入口有四个：

```
openslack setup
openslack ask "..."
openslack status
openslack doctor
```

### 13.1 `openslack setup`

运行完整 setup checklist：

```
workspace validate
golden evals
github labels
github doctor
genesis validate
```

当前 `setup.ts` 已经实现默认 action，裸 `openslack setup` 会执行 full checklist；`openslack setup run` 也等价执行该流程。

### 13.2 `openslack setup github`

引导用户配置 GitHub App 或 PAT。

如果 GitHub App env vars 已存在，它会测试 token；如果没有凭证，它会输出 GitHub App 与 PAT 的配置步骤。

### 13.3 `openslack setup smoke`

运行 smoke test：

```
workspace validate
golden evals --clean
github doctor
genesis validate
```

该命令当前已移除 repair-labels，更接近 read-only smoke test。

### 13.4 `openslack ask`

自然语言入口，将用户请求路由到内部命令。

当前它仍是规则路由器，不是 LLM planner，但已经能处理常见 intent。

## 14. CLI 高级命令

除用户主入口外，OpenSlack 仍提供高级 CLI：

```
openslack workspace validate
openslack workspace index
openslack workspace status

openslack self classify-pr
openslack self validate
openslack self eval
openslack self observe
openslack self triage
openslack self review
openslack self scorecard
openslack self monitor

openslack agent hire
openslack agent bootstrap
openslack agent tick

openslack task checkout
openslack task sync

openslack github doctor
openslack github repair-labels
openslack github repair-claims
openslack github repair-all
openslack github metrics
openslack github issue-done
```

## 15. 自我保护机制

OpenSlack 使用四区风险模型。

### 15.1 Green Zone

低风险，可自动处理：

```
docs/**
templates/**
.openslack/tasks/**
.openslack/self/scorecards/**
```

### 15.2 Yellow Zone

需要 agent review：

```
apps/**
packages/**
非核心策略文件
```

### 15.3 Red Zone

必须 human approval：

```
.github/**
.openslack/policies/**
.openslack/agents/**
.openslack/self/constitution.md
.openslack/self/invariants.yaml
packages/kernel/**
packages/self-evolution/core/**
```

### 15.4 Black Zone

永远拒绝：

```
.env
*.pem
*.key
secrets/**
credentials/**
```

## 16. Agent 入职

OpenSlack 提供 agent onboarding 模板。模板包含：

- START_HERE.md
- identity.yaml
- github_task_contract.yaml
- claim_policy.yaml
- schedule.github-actions.yml
- codex_automation_prompt.md
- claude_routine_prompt.md
- local_cron.example
- first_day_checklist.md

Agent 通过以下命令入职：

```
openslack agent hire --agent-id codex_developer
```

入职后 agent 可以：

```
openslack agent bootstrap --agent-id codex_developer
openslack agent tick --agent-id codex_developer --source github-issues
```

## 17. 当前已验收能力

当前可认为已基本验收：

1. Self-Project Mode
2. Workspace validation
3. Workspace index
4. Constitution / invariants / policy
5. Risk zone classifier
6. Golden evals
7. Self observer
8. EVOL task creation
9. Agent onboarding
10. Agent bootstrap
11. GitHub App auth
12. GitHub Issues task creation
13. GitHub issue discovery
14. Git ref claim lock
15. Claim heartbeat / expiry
16. Issue lifecycle state machine
17. Worktree / PR proposal
18. Label repair
19. Claim repair
20. Operator entrypoint
21. Setup wizard
22. Genesis validate / rollback

## 18. 当前未完成或 deferred

### 18.1 Branch protection

当前仍是唯一真正 P0。

技术债文档说明：Branch protection ruleset 仍未配置，所有 commits 仍直接进入 main，且这违反 AGENTS.md 的宪法规则。

必须由 human admin 配置 GitHub Ruleset：

```
Require PR before merge
Require status checks
Require CODEOWNERS review
Block force push
Block branch deletion
```

### 18.2 Chat Gateway

Slack / Teams / webhook 等聊天前台仍 deferred。

### 18.3 Web Dashboard

Web UI 仍 deferred。

### 18.4 GitHub Project v2

Project v2 已降级为 optional projection，不再作为任务主队列。

### 18.5 Empty `.openslack/` directories

仍有部分空状态目录，当前视为 P2。

## 19. 产品成熟度

当前成熟度：**Developer Preview**

不是正式 1.0。

### 19.1 可以用于

- 自用型 agent workflow 实验
- OpenSlack 自身自进化
- GitHub Issues-first task loop 验证
- Claude / Codex agent 工作流原型
- 小团队内部实验

### 19.2 不建议用于

- 非技术用户直接使用
- 企业生产级 agent fleet
- 无 GitHub 环境
- 无人工监督的高风险自动合并
- 生产部署自动化

## 20. 成功指标

当前版本建议用以下指标衡量：

1. openslack setup 全部通过
2. 7/7 golden evals 通过
3. GitHub doctor 通过
4. 至少 1 个 issue task 被 agent 成功 claim
5. claim ref 正确生成
6. issue lifecycle 正确从 ready 到 claimed/review/done
7. PR body 正确链接 issue
8. branch protection 已配置
9. 无 Black Zone 泄漏
10. 无 agent self-approval

## 21. 推荐产品路线

### Phase 1.12：Product Convergence Finalization

目标：

1. README / current status / AGENTS 全部同步
2. Operator 正式定义为 Module 03
3. Branch protection 配置完成
4. 用户文档切换为三模块视角
5. compat shims 设置淘汰策略

### Phase 2：Chat Gateway

目标：

1. Slack / Teams / webhook adapter
2. Chat as projection
3. Human approval cards
4. Operator Agent 接入聊天软件

### Phase 3：Web Dashboard

目标：

1. Task overview
2. Agent overview
3. Claims / leases / repair dashboard
4. Human approval hub

## 22. 用户故事

### 用户故事 1：检查系统是否可用

```
openslack setup
```

系统应输出：

```
Workspace validate: PASS
Golden evals: PASS
GitHub doctor: PASS
Genesis validate: PASS
```

### 用户故事 2：自然语言检查状态

```
openslack ask "检查当前系统状态"
```

Operator 应路由到：

```
openslack github doctor
```

### 用户故事 3：创建 agent 任务

```
openslack ask "创建一个低风险任务，检查 README 文档"
```

未来理想行为：

```
Operator 生成 task manifest
创建 GitHub issue
打上 openslack:task / openslack:ready / risk:low 标签
```

当前实现仍是规则路由，完整任务生成能力有待增强。

### 用户故事 4：agent 领取任务

```
openslack agent tick --agent-id codex_developer --source github-issues
```

系统应：

```
查询 ready issue
创建 claim ref
更新 issue labels
写 claim comment
```

### 用户故事 5：任务完成

PR merge 后：

```
workflow 调用 github issue-done
删除 claim ref
issue 标记 done
```

## 23. 风险与限制

### 23.1 仍需人类治理

OpenSlack 当前不应无监督运行。Red Zone、branch protection、merge approval 仍需人类控制。

### 23.2 GitHub 是 runtime 依赖

OpenSlack 当前是 GitHub-backed，不是离线系统。

### 23.3 Operator 不是完整 LLM agent

`openslack ask` 当前是 intent router，而不是完整 multi-turn AI agent。

### 23.4 Branch protection 未完成前，自我治理不完整

在 GitHub Ruleset 未配置前，OpenSlack 的 "no direct push to main" 规则还只是文档约束，不是平台强制约束。

## 24. 当前最终判断

OpenSlack 当前已经具备：

- 一个可运行的 Self-Evolution Kernel
- 一个可运行的 GitHub Issues Task Loop
- 一个 setup wizard
- 一个 Operator 单入口雏形
- 一个基本自包含的 GitHub-backed workspace

但它尚未完全具备：

- 产品层最终收敛
- Chat 入口
- Web Dashboard
- 完整 conversation agent
- GitHub branch protection 强约束
- 普通用户开箱即用体验

因此最终产品判断是：

```
OpenSlack v0.1 Developer Preview
Status: Substantial Pass, not Final Product Pass
```

## 25. 推荐首页摘要

如果要把产品文档压缩成首页摘要，可以这样写：

```
OpenSlack is a local-first, Git-backed operating system for AI agents.

It gives AI agents a company-like workflow:
- GitHub Issues are tasks.
- Git refs are atomic claim locks.
- Worktrees are isolated workspaces.
- Pull requests are delivery artifacts.
- .openslack is the durable company state.
- Humans approve high-risk changes.
- The Operator provides a natural-language entry point.

Current status:
- Self-Evolution Kernel: active.
- GitHub Issues Task Loop: active.
- Operator: active but early.
- Chat Gateway: deferred.
- Web Dashboard: deferred.
- Branch protection: pending human admin setup.
```
