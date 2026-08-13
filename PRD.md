# PRD — Agent Project Setup

**项目名称：** Agent Project Setup  
**项目代号：** `agent-project-setup`  
**npm Package：** `@apparux/agent-project-setup`  
**核心 Skill：** `project-setup`  
**版本：** `v0.1`  
**状态：** Ready for Design  
**目标 Harness：** Claude Code / Codex CLI

---

# 1. 产品概述

Agent Project Setup 是一个面向 AI Coding Agent 的项目初始化工具。

它的目标不是创建代码项目，也不是生成一套固定的 AI 配置模板，而是：

> **进入一个已有代码仓库后，自动理解项目，根据真实项目证据，为 Claude Code 和 Codex 搭建一套最小、分层、可维护的 Agent 工作环境。**

用户首次安装：

```bash
npx @apparux/agent-project-setup@latest install
```

之后进入任意项目：

Claude Code：

```text
/project-setup
```

Codex：

```text
$project-setup
```

`project-setup` 负责分析当前代码仓库，并根据项目实际情况建立：

```text
Minimal AGENTS.md
        +
CLAUDE.md Adapter
        +
Project-specific Skills
        +
Agent Documentation
        +
Guardrail Recommendations
```

最终目标是让新的 Coding Agent 进入项目时能够：

```text
快速理解项目基本规则
        ↓
按需加载专项知识
        ↓
先调查再修改
        ↓
遵循项目已有架构
        ↓
获得明确验证反馈
        ↓
避免不必要的 Context 污染
```

---

# 2. 问题定义

AI Coding Agent 在进入陌生代码库时通常存在以下问题：

- 不知道项目真正重要的全局规则；
- 不知道如何正确构建、测试或验证项目；
- 不知道哪些知识是项目专项工作流；
- `AGENTS.md` / `CLAUDE.md` 容易变成大型项目百科；
- 大量可从源码获得的信息被重复写入永久 Context；
- Claude Code 与 Codex 可能维护两套重复甚至冲突的规则；
- 项目已有开发规范、Skills 或 Agent 配置容易被新的初始化流程覆盖；
- Agent 配置初始化后无法随着项目变化安全更新；
- 项目专项工作流没有采用 Progressive Disclosure；
- 可以通过程序强制执行的规则仍然只依赖自然语言 Prompt。

Agent Project Setup 应解决这些问题。

---

# 3. 产品目标

## 3.1 核心目标

通过一次：

```text
/project-setup
```

或：

```text
$project-setup
```

完成：

```text
Explore Repository
        ↓
Build Project Profile
        ↓
Classify Project Knowledge
        ↓
Detect Existing Agent Configuration
        ↓
Detect Project-specific Workflows
        ↓
Generate Setup Proposal
        ↓
User Review
        ↓
Apply
        ↓
Validate
```

---

## 3.2 最终结果

典型项目完成 Setup 后可能形成：

```text
project/
│
├── AGENTS.md
├── CLAUDE.md
│
├── .agents/
│   └── skills/
│       ├── build-verify/
│       │   └── SKILL.md
│       └── audit-log/
│           └── SKILL.md
│
├── .claude/
│   └── skills/
│       ├── build-verify -> ../../.agents/skills/build-verify
│       └── audit-log -> ../../.agents/skills/audit-log
│
├── docs/
│   └── agents/
│       ├── architecture.md
│       └── verification.md
│
└── existing project source...
```

并不是所有项目都必须生成上述所有内容。

生成内容必须由实际项目需求决定。

---

# 4. 非目标

v0.1 明确不负责：

```text
创建新的业务项目
自动重构生产代码
自动把代码重构成 Deep Modules
自动修复架构问题
自动修改 CI
自动安装 MCP Server
自动安装业务 Dependency
自动修改 package.json / pom.xml
自动修改数据库
自动执行 migration
自动 commit
自动 push
自动创建 Pull Request
自动生成大型项目百科
自动建立代码向量数据库
自动建立完整 AST / dependency graph engine
```

Agent Project Setup 是：

> **Agent 工作环境初始化器。**

不是：

> **代码库自动重构器。**

---

# 5. 核心设计原则

## 5.1 Minimal Global Context

`AGENTS.md` 必须保持小而稳定。

只有同时满足以下条件的信息才适合进入全局 Context：

```text
长期稳定
+
大量任务都会涉及
+
Agent 无法可靠从项目自行推导
```

例如：

```text
必须保持 JDK 8 兼容
项目统一使用 pnpm
禁止跨模块直接访问内部实现
所有修改必须运行指定验证
项目要求 Minimal Implementation
```

不应该进入：

```text
UserService 当前位于哪里
Controller 有哪些方法
某实现类当前有多少字段
项目当前目录树
某业务方法具体怎么实现
```

这类信息应在任务执行时通过源码重新发现。

---

## 5.2 Progressive Disclosure

项目知识必须按层加载：

```text
AGENTS.md
    │
    │ 最小全局规则
    ▼
Skills
    │
    │ 专项工作流
    ▼
docs/
    │
    │ 深入说明
    ▼
Source Code
```

原则：

> 先告诉 Agent 去哪里获取知识，而不是一开始把所有知识全部塞进 Context。

---

## 5.3 Evidence First

任何自动生成的项目规则都必须有实际证据。

有效证据包括：

```text
source code
build files
CI configuration
existing documentation
existing Agent configuration
package scripts
project manifests
repository conventions
```

禁止根据行业惯例直接猜测项目规则。

例如：

```text
检测到 Spring Boot
```

不代表可以自动写：

```text
所有项目必须使用 Controller → Service → Repository。
```

除非 repository 中存在对应证据。

---

## 5.4 Preserve Before Generate

发现已有：

```text
AGENTS.md
CLAUDE.md
Skills
Hooks
Agent docs
```

必须：

```text
Read
↓
Understand
↓
Compare
↓
Propose
↓
Merge
```

不得：

```text
Delete
↓
Regenerate Everything
```

---

## 5.5 Minimal Implementation

产品自身必须遵循：

```text
优先使用 Agent 自身能力
        ↓
必要时增加小型辅助脚本
        ↓
再考虑增加额外程序代码
```

禁止因为自动化需求过早构建大型：

```text
repository analyzer
rule engine
plugin framework
dependency graph engine
static analysis platform
```

---

# 6. 产品架构

产品由两个明确分离的部分组成：

```text
                npm Registry
                     │
                     ▼
          Lightweight Node CLI
                     │
        install / update / doctor
                     │
                     ▼
         project-setup Mother Skill
                     │
             ┌───────┴───────┐
             ▼               ▼
        Claude Code         Codex
             │               │
             └───────┬───────┘
                     ▼
                 Repository
```

---

# 7. Node CLI 职责

Node CLI 只负责：

```text
Distribution
Installation
Update
Uninstall
Health Check
Version
```

Node CLI 不负责：

```text
理解项目架构
判断业务规则
决定 AGENTS.md 内容
判断是否需要 audit-log Skill
生成项目业务 Skill
分析模块设计
决定 Deep Module 边界
```

这些属于 `project-setup` Skill。

原则：

```text
CLI manages files.

Agent understands projects.
```

---

# 8. npm Package

npm package：

```text
@apparux/agent-project-setup
```

主推荐使用方式：

```bash
npx @apparux/agent-project-setup@latest <command>
```

不要求用户提前全局安装。

同时允许：

```bash
npm install -g @apparux/agent-project-setup
```

之后：

```bash
agent-project-setup <command>
```

但 README 默认应优先推荐 `npx`。

---

# 9. Repository Structure

项目推荐结构：

```text
agent-project-setup/
│
├── README.md
├── LICENSE
│
├── package.json
├── package-lock.json
│
├── PRD.md
├── DESIGN.md
├── TASKS.md
│
├── bin/
│   └── agent-project-setup.js
│
├── src/
│   └── cli/
│       ├── install.js
│       ├── update.js
│       ├── uninstall.js
│       ├── doctor.js
│       ├── version.js
│       │
│       └── shared/
│           ├── paths.js
│           ├── filesystem.js
│           ├── manifest.js
│           └── links.js
│
├── skills/
│   └── project-setup/
│       ├── SKILL.md
│       │
│       ├── references/
│       │   ├── classification.md
│       │   ├── agents-guidelines.md
│       │   ├── skills-guidelines.md
│       │   ├── detection-guidelines.md
│       │   ├── proposal-guidelines.md
│       │   └── reconciliation-guidelines.md
│       │
│       └── scripts/
│           └── detect-project.js
│
└── tests/
    ├── cli/
    │   ├── install.test.js
    │   ├── update.test.js
    │   ├── uninstall.test.js
    │   ├── doctor.test.js
    │   └── version.test.js
    │
    └── fixtures/
        ├── java-maven-simple/
        ├── java-maven-monorepo/
        ├── node-pnpm/
        ├── python/
        ├── existing-agents/
        ├── existing-claude/
        ├── existing-both/
        ├── existing-skills/
        └── mixed-monorepo/
```

具体内部文件拆分可在 DESIGN 阶段根据最小实现原则调整。

PRD 不要求为了匹配目录而创建没有实际职责的文件。

---

# 10. package.json

必须暴露：

```text
agent-project-setup
```

CLI。

参考：

```json
{
  "name": "@apparux/agent-project-setup",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "agent-project-setup": "./bin/agent-project-setup.js"
  },
  "files": [
    "bin",
    "src",
    "skills"
  ]
}
```

入口：

```javascript
#!/usr/bin/env node
```

MVP 优先使用：

```text
Node.js standard library
+
ESM JavaScript
```

除非 DESIGN 阶段有充分理由，否则不引入大型 CLI Framework。

---

# 11. CLI Commands

v0.1 必须支持：

```bash
npx @apparux/agent-project-setup@latest install
```

```bash
npx @apparux/agent-project-setup@latest update
```

```bash
npx @apparux/agent-project-setup@latest doctor
```

```bash
npx @apparux/agent-project-setup@latest uninstall
```

```bash
npx @apparux/agent-project-setup@latest --version
```

---

# 12. Stable Installation Directory

`npx` 只用于获取并执行 npm package。

长期 Skill 文件不能依赖临时 npm 执行路径。

正式安装目录：

```text
~/.agent-project-setup/
```

推荐：

```text
~/.agent-project-setup/
│
├── current/
│   └── skills/
│       └── project-setup/
│           ├── SKILL.md
│           ├── references/
│           └── scripts/
│
└── install.json
```

Claude / Codex 都应引用这里的 canonical Skill。

---

# 13. Installation Manifest

安装状态保存：

```text
~/.agent-project-setup/install.json
```

建议包含：

```json
{
  "package": "@apparux/agent-project-setup",
  "version": "0.1.0",
  "installedAt": "...",
  "installRoot": "...",
  "targets": {
    "codex": {
      "path": "...",
      "mode": "symlink"
    },
    "claude": {
      "path": "...",
      "mode": "symlink"
    }
  }
}
```

Manifest 用于：

```text
update
doctor
uninstall
ownership validation
```

禁止保存：

```text
API Key
Token
Credential
Repository secrets
```

---

# 14. Install

命令：

```bash
npx @apparux/agent-project-setup@latest install
```

流程：

```text
Resolve Home Directory
        ↓
Detect Platform
        ↓
Inspect Existing Installation
        ↓
Create Stable Installation Directory
        ↓
Copy Mother Skill
        ↓
Install Codex Skill Target
        ↓
Install Claude Skill Target
        ↓
Write Manifest
        ↓
Validate
```

---

# 15. Codex Installation Target

目标：

```text
~/.agents/skills/project-setup
```

优先方式：

```text
symlink
    ↓
~/.agent-project-setup/current/skills/project-setup
```

---

# 16. Claude Code Installation Target

目标：

```text
~/.claude/skills/project-setup
```

优先方式：

```text
symlink
    ↓
~/.agent-project-setup/current/skills/project-setup
```

最终：

```text
             canonical mother Skill
                      │
        ~/.agent-project-setup/
                      │
              ┌───────┴───────┐
              ▼               ▼
         Codex target     Claude target
```

两套 Agent 使用同一份母 Skill。

---

# 17. Symlink Fallback

默认优先使用 symlink。

如果平台或权限导致 symlink 无法建立：

```text
fallback
↓
managed copy
```

Managed Copy 必须：

- 由安装器明确管理；
- 在 `install.json` 中记录；
- update 时同步；
- uninstall 时仅删除属于本工具的副本。

不得因为 fallback 而创建两套需要人工同步的 Skill 源码。

---

# 18. Existing Target Protection

如果：

```text
~/.agents/skills/project-setup
```

或：

```text
~/.claude/skills/project-setup
```

已存在，安装器必须判断：

```text
Is managed by Agent Project Setup?
```

如果是：

```text
safe reconcile
```

如果不是：

```text
stop
+
report conflict
```

不得覆盖未知用户文件。

---

# 19. Install Output

成功输出应简洁：

```text
Agent Project Setup 0.1.0

Installation
  ✓ ~/.agent-project-setup/current

Codex
  ✓ ~/.agents/skills/project-setup

Claude Code
  ✓ ~/.claude/skills/project-setup

Ready.

Claude Code:
  /project-setup

Codex:
  $project-setup
```

---

# 20. Update

命令：

```bash
npx @apparux/agent-project-setup@latest update
```

更新对象：

> `project-setup` 母 Skill 与安装器自身管理的用户级资产。

不包括：

```text
业务项目的 AGENTS.md
业务项目的 CLAUDE.md
业务项目的 Skills
业务项目 docs
```

---

# 21. Update Workflow

```text
Read Manifest
        ↓
Validate Managed Installation
        ↓
Compare Installed Version
        ↓
Stage New Mother Skill
        ↓
Safely Replace Managed Content
        ↓
Repair Managed Targets
        ↓
Update Manifest
        ↓
Validate
```

如果已经是当前版本：

```text
Already up to date.
```

应避免无意义文件修改。

---

# 22. Tool Update 与 Project Reconcile

必须严格区分：

## Tool Update

```bash
npx @apparux/agent-project-setup@latest update
```

负责：

```text
更新母 Skill
```

---

## Project Reconcile

Claude：

```text
/project-setup
```

Codex：

```text
$project-setup
```

负责：

```text
重新扫描当前项目
↓
发现项目变化
↓
更新当前项目 Agent 配置
```

两者不得混合。

---

# 23. Uninstall

命令：

```bash
npx @apparux/agent-project-setup@latest uninstall
```

只允许删除：

```text
~/.agent-project-setup/
```

以及由本工具管理的：

```text
~/.agents/skills/project-setup
~/.claude/skills/project-setup
```

---

# 24. Ownership Protection

卸载前必须确认目标仍属于当前安装。

如果用户已经把：

```text
~/.agents/skills/project-setup
```

替换成其他文件或其他 symlink：

```text
do not delete
```

原则：

> 只删除自己拥有的文件。

---

# 25. Project Assets Survive Uninstall

以下项目资产永远不能因为卸载工具被删除：

```text
<repository>/AGENTS.md
<repository>/CLAUDE.md
<repository>/.agents/
<repository>/.claude/
<repository>/docs/agents/
```

这些属于业务项目。

不是安装器资产。

---

# 26. Doctor

命令：

```bash
npx @apparux/agent-project-setup@latest doctor
```

检查：

```text
manifest
canonical install
installed version
mother SKILL.md
Codex target
Claude target
target ownership
symlink validity
managed copy validity
read permissions
platform
```

示例：

```text
Agent Project Setup

Version
  Installed: 0.1.0
  Running:   0.1.0

Installation
  ✓ ~/.agent-project-setup/current

Codex
  ✓ project-setup installed
  ✓ target valid

Claude Code
  ✓ project-setup installed
  ✓ target valid

Status
  ✓ Healthy
```

异常必须给出明确修复建议。

---

# 27. Version

支持：

```bash
npx @apparux/agent-project-setup@latest --version
```

输出：

```text
agent-project-setup 0.1.0
```

版本必须来源于 package metadata。

不得维护第二套独立版本常量。

---

# 28. Project Setup Skill

真正的项目分析能力位于：

```text
skills/project-setup/SKILL.md
```

这是产品核心。

它负责：

```text
理解 repository
识别项目规则
判断知识作用域
发现专项工作流
生成 Proposal
生成 AGENTS.md
生成 CLAUDE.md adapter
生成项目 Skills
维护已有 Agent 配置
```

---

# 29. Project Setup Workflow

完整流程：

```text
Phase 0
Preflight

Phase 1
Explore

Phase 2
Build Project Profile

Phase 3
Classify Knowledge

Phase 4
Detect Project Skills

Phase 5
Generate Proposal

Phase 6
Apply

Phase 7
Validate
```

---

# 30. Phase 0 — Preflight

执行前确定：

```text
current working directory
repository root
Git status
existing Agent files
existing Skill directories
```

必须关注：

```text
staged
unstaged
untracked
```

不要求 repository 必须 clean。

但必须避免覆盖用户正在修改的 Agent 配置。

---

# 31. Phase 1 — Explore

第一阶段必须是：

> READ ONLY。

Agent 应探索：

## Repository

```text
Git root
directory structure
single project / monorepo
modules
packages
apps
libraries
framework directories
```

## Languages

例如：

```text
Java
Kotlin
JavaScript
TypeScript
Python
Go
Rust
C#
```

## Runtime

例如：

```text
Java version
Node version
Python version
```

## Build System

例如：

```text
pom.xml
build.gradle
package.json
pnpm-lock.yaml
yarn.lock
package-lock.json
pyproject.toml
Cargo.toml
go.mod
Makefile
```

## CI / Verification

例如：

```text
GitHub Actions
package scripts
Maven goals
Gradle tasks
Makefile commands
test configuration
lint configuration
```

## Existing Documentation

例如：

```text
README
CONTRIBUTING
docs/
architecture docs
developer docs
```

## Existing Agent Configuration

必须检查：

```text
AGENTS.md
AGENTS.override.md

CLAUDE.md
CLAUDE.local.md

.agents/
.claude/

.cursor/
.github/copilot-instructions.md
```

---

# 32. Repository Exploration Principle

Agent 应优先：

```text
Search
↓
Read relevant files
↓
Cross-check
```

避免：

```text
Read entire repository
```

目标是形成足够可靠的 mental model，而不是穷举所有源码。

---

# 33. Phase 2 — Project Profile

探索后建立内部 Project Profile。

示例：

```yaml
project:
  type: monorepo

languages:
  - java

runtime:
  java: 8

build:
  system: maven

frameworks:
  - spring-boot

persistence:
  - mybatis

database:
  - mysql

modules:
  - app
  - base
  - framework

verification:
  build: "<detected command>"
  test: "<detected command>"

agent_config:
  agents_md: false
  claude_md: true
  project_skills: false
```

Project Profile 默认属于运行时中间数据。

MVP 不要求永久保存。

---

# 34. Knowledge Classification

发现的项目知识必须分类为：

```text
GLOBAL
WORKFLOW
DETERMINISTIC
DISCOVERABLE
ARCHITECTURE
```

这是 `project-setup` 的核心决策模型。

---

# 35. GLOBAL

定义：

> 所有或绝大多数任务都应该知道，并且长期稳定的项目规则。

目标：

```text
AGENTS.md
```

例如：

```text
JDK compatibility
package manager
repository-wide constraints
verification expectations
minimal implementation policy
universal safety expectations
```

---

# 36. WORKFLOW

定义：

> 只有特定类型任务才需要的项目知识。

目标：

```text
.agents/skills/<skill>/SKILL.md
```

例如：

```text
audit logging
database migration
deployment
release
build verification
special testing workflow
API development workflow
```

---

# 37. DETERMINISTIC

定义：

> 可以由程序稳定判断、阻止或验证的规则。

例如：

```text
禁止 git reset --hard
禁止 npm
禁止直接 push main
禁止修改 generated directory
```

优先：

```text
Hook
Script
CI check
Permission
```

而不是依赖自然语言提醒。

v0.1 默认只给出 Guardrail Recommendation。

---

# 38. DISCOVERABLE

定义：

> Agent 可以通过源码或文件系统可靠重新发现的信息。

例如：

```text
某 Service 所在目录
Controller 列表
模块文件数量
类方法清单
某业务当前具体实现
```

处理：

```text
Do not persist.
```

---

# 39. ARCHITECTURE

定义：

> 不适合放进 Global Context，但对复杂任务长期有价值的架构说明。

目标：

```text
docs/agents/
```

例如：

```text
docs/agents/architecture.md
docs/agents/verification.md
```

`AGENTS.md` 只保存按需入口。

---

# 40. Classification Evidence

每一个准备持久化的项目事实都应能回答：

```text
What was discovered?
Where was it discovered?
Why does it matter?
What classification does it belong to?
Where should it be stored?
```

示例：

```text
Fact:
Java source compatibility is 8.

Evidence:
pom.xml

Classification:
GLOBAL

Destination:
AGENTS.md

Reason:
Repository-wide runtime constraint.
```

---

# 41. AGENTS.md

`AGENTS.md` 是项目公共 Agent Rules Source of Truth。

默认结构：

```markdown
# Repository Rules

## Environment

## Working Principles

## Verification

## Project Knowledge

## Safety
```

实际没有内容的章节可以省略。

---

# 42. AGENTS.md 内容限制

禁止为了完整感生成：

```text
完整项目简介
完整目录树
所有 dependencies
所有 module 清单
所有 Service 清单
所有 Controller 清单
大量源码路径
长篇 architecture explanation
```

目标：

```text
high signal
low noise
stable
scannable
```

---

# 43. CLAUDE.md

共享规则不得复制到 `CLAUDE.md`。

默认：

```markdown
@AGENTS.md
```

仅存在 Claude Code 专属配置需求时：

```markdown
@AGENTS.md

# Claude Code

- <Claude-specific rule>
```

目标：

```text
AGENTS.md
   │
   ├── Codex
   │
   └── CLAUDE.md
          │
          └── Claude Code
```

---

# 44. Project Skills

项目专项 Skill canonical source：

```text
.agents/skills/
```

例如：

```text
.agents/
└── skills/
    ├── build-verify/
    │   └── SKILL.md
    └── audit-log/
        └── SKILL.md
```

Claude 对应：

```text
.claude/skills/
```

优先引用同一份 Skill。

---

# 45. Skill Candidate Detection

不能：

```text
检测到 Java
↓
生成 java-backend
```

必须：

```text
检测到 Java
↓
是否存在项目特有、重复使用、需要专门说明的工作流？
        │
       Yes
        │
        ▼
     Skill Candidate
```

技术栈本身不是创建 Skill 的充分条件。

---

# 46. Skill Candidate Categories

系统可以识别但不限于：

```text
build-verify
testing
database-migration
deployment
api-development
audit-log
code-review
release
frontend-development
backend-development
```

这些只是：

```text
candidate categories
```

不是默认安装列表。

---

# 47. Skill Generation Rules

每个 Skill 必须：

```text
Focused
Task-specific
Evidence-based
Minimal
Reusable
```

Skill 应主要包含：

```text
When to use
When not to use
Workflow
Project-specific rules
Verification
References
```

---

# 48. Skill 禁止内容

不得大量复制：

```text
AGENTS.md
整个 architecture 文档
完整源码目录
大量瞬时文件路径
可以重新搜索得到的实现细节
```

---

# 49. Project Skill Cross-Agent Sharing

项目 Skill 应尽量只维护一个 canonical source。

推荐：

```text
.agents/skills/audit-log/
```

Claude：

```text
.claude/skills/audit-log
    ↓
symlink
    ↓
../../.agents/skills/audit-log
```

如果 symlink 不可用，可采用 managed copy。

---

# 50. Hooks / Guardrails

`project-setup` 可以发现适合强制执行的规则。

例如：

```text
package manager enforcement
destructive Git command protection
generated source protection
main branch push protection
```

v0.1 默认行为：

```text
Detect
↓
Explain
↓
Recommend
```

不得默认安装会改变开发者操作行为的 Hook。

未来可以增加用户批准后的 Hook 安装能力。

---

# 51. Deep Modules

`project-setup` 可以观察：

```text
module boundaries
cross-module coupling
public interfaces
large shallow dependency chains
architecture hotspots
```

但只能：

```text
Detect
Describe
Recommend
```

不得：

```text
Refactor
Move classes
Rewrite architecture
Create new modules
```

Deep Module 重构必须属于独立开发任务。

---

# 52. Proposal

任何项目文件写入之前，必须输出 Proposal。

示例：

```text
Project Setup Proposal

Project
-------
Java 8
Spring Boot
Maven multi-module

AGENTS.md
---------
CREATE

+ JDK 8 compatibility
+ minimal implementation
+ verification expectations

CLAUDE.md
---------
CREATE

+ import @AGENTS.md

Skills
------
CREATE build-verify
CREATE audit-log

SKIP java-backend
Reason:
No project-specific Java workflow requiring a dedicated skill.

Hooks
-----
RECOMMEND destructive-git guard

Architecture
------------
KEEP existing architecture
CREATE docs/agents/architecture.md
```

---

# 53. Proposal Actions

必须明确区分：

```text
CREATE
UPDATE
KEEP
SKIP
RECOMMEND
```

用户应该能快速理解：

```text
准备创建什么
准备修改什么
为什么
什么不会修改
```

---

# 54. Apply

用户批准后才允许执行写入。

推荐顺序：

```text
1. AGENTS.md
2. CLAUDE.md
3. project Skills
4. Claude Skill references
5. docs/agents
6. validation
```

---

# 55. Project Write Scope

默认只允许修改：

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
docs/agents/
```

默认禁止修改：

```text
src/
app/
packages/
pom.xml
build.gradle
package.json
CI files
database
production config
business source code
```

---

# 56. Existing Configuration Preservation

如果已有：

```text
AGENTS.md
CLAUDE.md
Skills
```

必须保留用户有效内容。

流程：

```text
Read Existing
↓
Understand Intent
↓
Detect Conflict
↓
Generate Proposed Diff
↓
Merge Conservatively
```

---

# 57. Reconciliation

重复执行：

```text
/project-setup
```

或：

```text
$project-setup
```

自动进入 reconcile 模式。

例如检测：

```text
JDK 8 → JDK 17
新增 Flyway
验证命令变化
新增 deployment workflow
```

应产生：

```text
UPDATE AGENTS.md
UPDATE build-verify Skill
CREATE database-migration Skill
```

---

# 58. Idempotency

没有项目变化时重复运行：

```text
/project-setup
```

应达到：

> **ideally zero diff**

禁止每次运行都：

```text
重排 Markdown
重写相同内容
改变无意义措辞
重新生成同样文件
```

---

# 59. Unknown Handling

遇到不能确认的事实：

```text
Unknown
```

例如：

```text
Test command: Unknown
```

不得凭经验写：

```text
mvn test
```

除非项目存在支持该结论的实际证据。

---

# 60. Deterministic Helper Scripts

允许 Skill 携带小型 helper：

```text
skills/project-setup/scripts/
```

职责：

```text
收集明确事实
```

例如：

```text
Git root
existing file names
manifest presence
lock files
known build files
language indicators
Agent config presence
```

原则：

```text
Script collects facts.

Agent interprets facts.
```

---

# 61. Helper Scripts 不负责

禁止 helper script 承担：

```text
理解业务
判断架构是否优秀
决定 AGENTS 内容
决定业务 Skill
分析 domain model
推导组织约定
```

---

# 62. Platform Support

v0.1 必须支持：

```text
Linux
macOS
WSL
```

Windows Native：

```text
best-effort
```

但实现必须明确考虑：

```text
path separator
home directory
symlink permissions
managed copy fallback
```

不得硬编码具体用户目录。

---

# 63. Node Requirement

目标：

```text
Node.js 18+
```

DESIGN 阶段可以在有充分技术理由时调整。

优先：

```text
ESM
Node standard library
No build step
```

---

# 64. CLI Error Handling

CLI 必须正确处理：

```text
permission denied
broken symlink
unknown existing target
corrupt install.json
partial installation
missing canonical Skill
invalid home directory
managed copy mismatch
```

禁止静默修复可能属于用户的数据。

---

# 65. Skill Error Handling

Skill 必须：

```text
缺少证据 → Unknown
存在冲突 → Explain
已有用户配置 → Preserve
不能安全合并 → Ask / Recommend
```

不得通过猜测强行完成 Setup。

---

# 66. CLI User Experience

CLI 输出应：

```text
简洁
稳定
可扫描
可复制
```

不打印不必要的底层操作日志。

主要展示：

```text
version
installation path
target state
success/failure
recommended fix
```

---

# 67. Skill User Experience

`project-setup` 输出重点：

```text
What was detected
What matters
What will change
Why it will change
What will not change
Unknowns
Warnings
```

避免把 repository exploration log 原样倒给用户。

---

# 68. CLI Testing

至少覆盖：

```text
fresh install
repeat install
install conflict
same-version update
version upgrade
healthy doctor
broken Codex target
broken Claude target
uninstall
uninstall after target replacement
symlink fallback
managed copy update
permission failure
corrupt manifest
```

测试不得操作开发者真实：

```text
~/.agents
~/.claude
```

必须使用 temporary HOME。

---

# 69. Project Fixtures

至少提供：

```text
tests/fixtures/

01-java-maven-simple
02-java-maven-monorepo
03-node-pnpm
04-python
05-existing-agents
06-existing-claude
07-existing-both
08-existing-skills
09-no-git
10-mixed-monorepo
```

---

# 70. Project Setup Testing Focus

测试重点不是要求 Agent 每次生成完全相同文字。

重点验证：

```text
classification correctness
scope correctness
preservation
idempotency
evidence requirements
forbidden behavior
cross-agent compatibility
```

---

# 71. Acceptance Criteria — Distribution

## AC-D01

可直接执行：

```bash
npx @apparux/agent-project-setup@latest install
```

无需 global install。

## AC-D02

安装后存在稳定 canonical directory：

```text
~/.agent-project-setup/current
```

## AC-D03

不得依赖 npm 临时缓存目录作为长期 Skill 路径。

## AC-D04

Codex 能够发现 `project-setup`。

## AC-D05

Claude Code 能够发现 `project-setup`。

## AC-D06

两者使用同一 canonical mother Skill。

## AC-D07

支持：

```text
install
update
doctor
uninstall
--version
```

## AC-D08

重复 install 不产生破坏性结果。

## AC-D09

update 不修改任何业务 repository。

## AC-D10

uninstall 不删除任何业务项目资产。

## AC-D11

不得覆盖未知用户 Skill。

## AC-D12

symlink 失败时有 managed copy fallback。

## AC-D13

doctor 能识别 broken target 与损坏安装。

---

# 72. Acceptance Criteria — Project Setup

## AC-P01

能够识别典型 Java Maven 项目基本环境。

## AC-P02

能够识别典型 Node/pnpm 项目基本环境。

## AC-P03

不能因为识别技术栈就机械创建对应 Skill。

## AC-P04

`AGENTS.md` 保持 Minimal。

## AC-P05

不会把大量 Discoverable 信息放进 `AGENTS.md`。

## AC-P06

共享规则只有一份 Source of Truth。

## AC-P07

`CLAUDE.md` 默认通过：

```markdown
@AGENTS.md
```

复用共享规则。

## AC-P08

项目专项知识可以生成 scoped Skill。

## AC-P09

生成 Skill 必须有项目 evidence。

## AC-P10

已有 `AGENTS.md` 不会被直接覆盖。

## AC-P11

已有 `CLAUDE.md` 不会被直接覆盖。

## AC-P12

已有 Skills 不会被直接覆盖。

## AC-P13

未确认的信息不得猜测。

## AC-P14

默认不修改业务源码。

## AC-P15

默认不修改 CI。

## AC-P16

默认不安装 Hook。

## AC-P17

Deep Module 分析不得触发自动架构重构。

## AC-P18

没有项目变化时重复执行 ideally zero diff。

---

# 73. Quality Priorities

优先级从高到低：

```text
1. 不破坏用户项目
2. 不覆盖用户已有 Agent 配置
3. 不生成错误事实
4. 不污染 Global Context
5. 保持 Claude / Codex 单一规则源
6. 保持 Project Skills 聚焦
7. 支持安全重复运行
8. 安装生命周期稳定
9. 输出清晰
10. 自动化程度
```

核心原则：

> **宁可少生成，也不要乱生成。**

---

# 74. Implementation Constraints

优先：

```text
Agent Skill instructions
        ↓
small deterministic helper
        ↓
lightweight Node CLI
```

禁止未经必要性证明引入：

```text
大型 CLI framework
Dependency Injection framework
repository parsing framework
vector database
custom indexing system
large rule engine
compatibility layer
```

---

# 75. Milestone 1 — Distribution Foundation

完成：

```text
npm package
CLI entry
install
doctor
uninstall
version
stable installation directory
manifest
Claude target
Codex target
symlink fallback
```

---

# 76. Milestone 2 — Core Project Setup

完成：

```text
project-setup SKILL.md
repository exploration
project profile
knowledge classification
proposal
minimal AGENTS.md
CLAUDE.md adapter
```

---

# 77. Milestone 3 — Project Skills

完成：

```text
workflow detection
Skill candidate detection
Skill generation
cross-agent project Skill sharing
```

---

# 78. Milestone 4 — Maintenance

完成：

```text
CLI update
repository reconcile
idempotency
existing config preservation
fixtures
tests
```

---

# 79. Milestone 5 — Guardrails and Architecture Guidance

完成或评估：

```text
deterministic policy recommendations
Hook recommendations
architecture observations
Deep Module recommendations
```

不要求自动实施架构修改。

---

# 80. Definition of Done

v0.1 达到以下完整流程即认为可发布：

```text
Publish npm package
        ↓
npx @apparux/agent-project-setup@latest install
        ↓
Mother Skill installed to stable location
        ↓
Claude discovers project-setup
        ↓
Codex discovers project-setup
        ↓
Enter existing repository
        ↓
Run /project-setup
or
Run $project-setup
        ↓
Repository is explored
        ↓
Project Profile is built
        ↓
Knowledge is classified
        ↓
Proposal is shown
        ↓
User approves
        ↓
Minimal AGENTS.md is created/updated
        ↓
CLAUDE.md adapter is created/updated
        ↓
Necessary project Skills are created
        ↓
Existing configuration is preserved
        ↓
Validation succeeds
        ↓
Run project-setup again
        ↓
No project change
        ↓
Ideally zero diff
        ↓
npx ... doctor
        ↓
Healthy
        ↓
npx ... update
        ↓
Mother Skill safely updates
        ↓
npx ... uninstall
        ↓
Tool installation removed
        ↓
Business project assets remain untouched
```

---

# 81. 最终产品心智模型

```text
                     npm Registry
                          │
                          ▼
             Agent Project Setup CLI
                          │
          install / update / doctor
                          │
                          ▼
              Mother project-setup Skill
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
          Claude Code             Codex
                │                   │
                └─────────┬─────────┘
                          ▼
                     Repository
                          │
                    project-setup
                          │
                          ▼
                  Understand First
                          │
           ┌──────────────┼───────────────┐
           ▼              ▼               ▼
       Global Rules    Workflows      Architecture
           │              │               │
       AGENTS.md         Skills          Docs
           │
       CLAUDE.md
        Adapter
```

Agent Project Setup 的最终目的不是生成更多 AI 配置。

它的目标是：

> **使用尽可能少、尽可能准确、作用域清晰的持久 Context，让 Claude Code 和 Codex 能够快速进入陌生项目，并在正确的规则、专项知识和项目架构边界内工作。**

最终衡量标准不是：

> “生成了多少文件。”

而是：

> **新的 Agent 是否能更快理解项目、更少猜测、更少污染 Context，并且在项目演进后仍然能够安全维护这套工作环境。**