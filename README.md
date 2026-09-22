# Agent Init

简体中文 | [English](./docs/README.en.md)

Agent Init 为六个内置 Harness 及自定义 Harness 安装一个共享的用户级 `agent-init` Skill。项目级环境生成仍面向 Claude Code 和 Codex：该 Skill 会进入现有仓库，收集证据，提出最小化的 Agent 环境方案，并且仅在获得明确批准后写入文件。

> 状态：本文描述当前仓库实现。多 Harness 扩展已合并，尚未随此次改动发布 npm 包；`@latest` 获取的是已发布版本，可能不包含下述新增能力。
>
> 许可证：MIT。

## 从 `@apparux/agent-project-setup` 迁移

本包原名 `@apparux/agent-project-setup`,现已更名为 `@apparux/agent-init`。旧包已弃用,不再接收更新。新旧包使用不同的安装根目录,新包不会自动迁移旧安装,请按以下顺序迁移:

```bash
# 1. 安装新包(若提示目标已存在,先执行第 2 步再重试本命令)
npx @apparux/agent-init@latest install

# 2. 卸载旧包
npx @apparux/agent-project-setup@latest uninstall
```

说明:

- 第 2 步卸载旧包时,可能列出 `Preserved` 及 `~/.claude/skills/project-setup`、`~/.agents/skills/project-setup` 等条目并带 `!` 标记。**这是预期行为,不是异常**:这些路径由旧包创建,旧包拒绝删除所有权证据不匹配的内容。两步完成后,若这些 `project-setup` 条目仍存在,请手动删除(新包安装的是 `agent-init` 路径,不会接管旧路径)。
- 若卸载后确实留下了指向 `~/.agent-project-setup/` 的悬空符号链接(可用 `ls -la ~/.claude/skills` 确认),先删除它们再执行第 1 步。

## 环境要求

- Node.js 18 或更高版本
- Linux、macOS 或 WSL
- Windows Native 提供尽力支持，并可能使用托管副本回退方案

## 安装

推荐使用 `npx`，无需全局安装包：

```bash
npx @apparux/agent-init@latest install
```

安装器会将规范母 Skill 复制到以下稳定位置：

```text
~/.agent-init/current/skills/agent-init
```

随后，它会为六个内置 Harness 创建用户级发现目标，暴露同一个规范 Skill：

| Harness（ID） | 发现目标 | `verification` |
| --- | --- | --- |
| Codex（`codex`） | `~/.agents/skills/agent-init` | `accepted` |
| Claude Code（`claude`） | `~/.claude/skills/agent-init` | `accepted` |
| Cursor（`cursor`） | `~/.cursor/skills/agent-init` | `unverified` |
| OpenCode（`opencode`） | `~/.config/opencode/skills/agent-init` | `unverified` |
| Pi（`pi`） | `~/.pi/agent/skills/agent-init` | `unverified` |
| Grok Build（`grok`） | `~/.grok/skills/agent-init` | `unverified` |

`verification` 是 registry 中的验收标记，不是本机运行结果。后四个 Harness 尚未通过真实 Harness 验收，安装目标存在不代表已验证其发现或调用行为。

安装器会优先使用符号链接。如果无法创建稳定且可验证所有权的符号链接，则可以改用托管副本，并在 `install.json` 中记录该模式。

安装完成后：

- Claude Code：`/agent-init`
- Codex：`$agent-init`

### 自定义 Harness

在 `~/.config/agent-init/harnesses.json` 中追加配置（不会替换内置项）：

```json
{
  "schemaVersion": 1,
  "harnesses": [
    {
      "id": "myagent",
      "label": "My Agent",
      "skillsDir": ".myagent/skills",
      "invocation": null
    },
    {
      "id": "shared-agent",
      "skillsDir": ".agents/skills"
    }
  ]
}
```

- `schemaVersion` 必须为 `1`，`harnesses` 必须为数组。
- `id` 必须匹配 `^[a-z][a-z0-9-]*$`，且不得与内置或其他自定义 ID 重复。
- `skillsDir` 是 HOME 内的相对目录，不使用 `~` 或绝对路径，也不得越出 HOME；安装器会在其下创建 `agent-init` 目标。
- `label` 可选，默认使用 ID；`invocation` 可选，仅用于显示调用提示，省略或设为 `null` 表示无提示，不构成调用验收。
- 规范化后的 `skillsDir` 若与已有项相同，该项成为别名并共享目标及安装状态，不重复安装。上例的 `shared-agent` 共享 Codex 目标。独立自定义项标为 `unverified`，别名显示为 `alias`。

首次安装使用 `install`；已有安装新增配置后使用 `update` 补齐目标，再用 `harnesses` 查看结果。无效配置会报错并停止，不会静默回退到内置列表。

## CLI

使用最新包负载执行生命周期操作：

```bash
npx @apparux/agent-init@latest install
npx @apparux/agent-init@latest update
npx @apparux/agent-init@latest doctor
npx @apparux/agent-init@latest harnesses
npx @apparux/agent-init@latest uninstall
npx @apparux/agent-init@latest --version
npx @apparux/agent-init@latest --help
```

如果该包是全局安装的，运行 `agent-init update` 只会应用当前已安装包的负载。若要获取最新发布的负载，请使用 `npx @apparux/agent-init@latest update`，或先更新全局包。

### `install`

创建稳定的规范安装，以及全部内置和自定义 Harness 的发现目标（别名共享目标）。对目标齐全的同一健康版本重复执行安装时不会产生变更。安装器绝不会覆盖未知目标。

### `update`

仅更新用户级母 Skill 和托管目标，不会扫描或修改当前仓库。旧安装只有 Claude/Codex 两个目标，或配置新增自定义 Harness 时，只要现有托管资源健康且新增路径未被占用，就会补齐 registry 中尚未记录的目标，即使版本和负载未变。目标齐全、同一版本、同一负载且安装健康时，才会报告已是最新状态；遇到未知目标、降级或完整性冲突时，会停止操作且不替换用户数据。

### `doctor`

以只读方式检查 manifest、规范 Skill、所有权证据、目标模式和目标内容，不会自动修复文件。

### `harnesses`

只读列出内置、自定义及别名 Harness 的目标路径、安装状态、模式和 `verification`，并显示已配置的调用提示。也会列出 manifest 中仍有记录、但已不在当前配置中的目标（`unregistered`）。该命令不安装或修复目标，也不执行真实 Harness 验收。

### `uninstall`

仅删除仍能证明由本安装器拥有的用户级资源。已被替换、发生漂移或存在歧义的目标会被保留并报告。通过 `agent-init` 创建的项目文件始终不会被卸载操作删除。

## 项目设置工作流

`/agent-init` 和 `$agent-init` 在当前仓库中运行，与 CLI 的 `update` 操作相互独立：

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
