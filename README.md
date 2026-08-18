# Agent Project Setup

简体中文 | [English](./docs/README.en.md)

Agent Project Setup 为 Claude Code 和 Codex 安装一个共享的 `project-setup` Skill。该 Skill 会进入现有仓库，收集证据，提出最小化的 Agent 环境方案，并且仅在获得明确批准后写入文件。

> 状态：v0.1.0。
>
> 许可证：MIT。

## 环境要求

- Node.js 18 或更高版本
- Linux、macOS 或 WSL
- Windows Native 提供尽力支持，并可能使用托管副本回退方案

## 安装

推荐使用 `npx`，无需全局安装包：

```bash
npx @apparux/agent-project-setup@latest install
```

安装器会将规范母 Skill 复制到以下稳定位置：

```text
~/.agent-project-setup/current/skills/project-setup
```

随后，它会向两个 Harness 暴露同一个规范 Skill：

```text
~/.agents/skills/project-setup
~/.claude/skills/project-setup
```

安装器会优先使用符号链接。如果无法创建稳定且可验证所有权的符号链接，则可以改用托管副本，并在 `install.json` 中记录该模式。

安装完成后：

- Claude Code：`/project-setup`
- Codex：`$project-setup`

## CLI

使用最新包负载执行生命周期操作：

```bash
npx @apparux/agent-project-setup@latest install
npx @apparux/agent-project-setup@latest update
npx @apparux/agent-project-setup@latest doctor
npx @apparux/agent-project-setup@latest uninstall
npx @apparux/agent-project-setup@latest --version
npx @apparux/agent-project-setup@latest --help
```

如果该包是全局安装的，运行 `agent-project-setup update` 只会应用当前已安装包的负载。若要获取最新发布的负载，请使用 `npx @apparux/agent-project-setup@latest update`，或先更新全局包。

### `install`

创建稳定的规范安装以及 Claude/Codex 发现目标。对同一健康版本重复执行安装时不会产生变更。安装器绝不会覆盖未知目标。

### `update`

仅更新由本安装器拥有的用户级母 Skill 和目标，不会扫描或修改当前仓库。同一版本、同一负载且安装健康时，会报告已是最新状态；遇到降级或完整性冲突时，会停止操作且不替换用户数据。

### `doctor`

以只读方式检查 manifest、规范 Skill、所有权证据、目标模式和目标内容，不会自动修复文件。

### `uninstall`

仅删除仍能证明由本安装器拥有的用户级资源。已被替换、发生漂移或存在歧义的目标会被保留并报告。通过 `project-setup` 创建的项目文件始终不会被卸载操作删除。

## 项目设置工作流

`/project-setup` 和 `$project-setup` 在当前仓库中运行，与 CLI 的 `update` 操作相互独立：

1. 预检和只读探索
2. 项目画像和证据账本
3. 知识分类
4. 项目特定工作流检测
5. 展示精确创建、更新、保留、跳过和建议操作的方案
6. 用户明确批准
7. 限定范围的应用和验证

未经明确批准，Skill 不会修改仓库。如果方案提出后目标发生变化，原批准将失效，必须重新生成方案。

默认情况下，Skill 只能对以下路径提出变更方案：

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
docs/agents/
```

它不会修改业务源码、构建 manifest、CI、数据库或生产配置。在 v0.1 中，护栏和架构改进仅作为建议：Skill 不会安装 hooks、更改权限、编辑 CI 或重构生产代码。

缺乏充分仓库证据的事实会保持为 `Unknown`。现有 Agent 文件和 Skills 会被读取并保守协调，而不是被删除后重新生成。

## 生成的目录结构

仓库只会获得由证据支持的资源。典型结果如下：

```text
AGENTS.md                         共享的最小规则
CLAUDE.md                        导入 @AGENTS.md 的轻量适配器
.agents/skills/<name>/SKILL.md   规范的项目工作流
.claude/skills/<name>            指向规范工作流的引用
docs/agents/                     可选的长期架构指南
```

仅检测到技术栈不会创建 Skill。项目 Skill 必须对应一个重复出现、项目特定且具有明确触发条件和验证方式的工作流。

## 安全模型

- 安装测试和生命周期检查使用隔离的临时 HOME。
- 修改前会验证所有托管路径。
- 不会仅因内容相似就接管未知文件或链接。
- Doctor 严格保持只读。
- 卸载不会搜索仓库路径，也不会删除发现目标的父目录。
- 项目应用必须经过方案批准，并且只能修改已批准的路径。
- 凭证和仓库 Secret 不会写入 `install.json` 或生成的 Agent 资源。

## 开发

```bash
npm test
npm pack --dry-run
```

测试使用 Node 内置测试运行器，无需构建步骤。发布验收还要求通过确定性的 Skill 契约和 fixture 验证、受支持平台验证、许可证决策、registry 授权以及明确的发布决策。登录 Claude Code 或 Codex 并不是发布门禁。
