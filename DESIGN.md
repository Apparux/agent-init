# DESIGN — Agent Init

**项目：** Agent Init  
**版本：** v0.1  
**状态：** Ready for Implementation  
**依据：** [PRD.md](PRD.md)

---

## 1. 文档目的

本文把 PRD 转换为可实现、可测试的技术设计，重点回答：

- npm CLI 与 `project-setup` 母 Skill 如何分工；
- 安装、更新、诊断、卸载如何保证安全和幂等；
- Claude Code 与 Codex 如何共享同一份母 Skill 和项目知识；
- repository evidence 如何被探索、分类、提案、应用和验证；
- 模块的 Interface、Seam、状态模型、错误模式和测试表面是什么。

本文不改变 PRD 的产品范围。v0.1 仍然是 **Agent 工作环境初始化器**，不是业务项目生成器、代码重构器、CI 修改器或 Hook 自动安装器。

---

## 2. 设计目标与约束

### 2.1 设计目标

1. **安全优先**：不覆盖未知文件，不删除失去所有权证明的文件，不修改业务源码。
2. **单一规则源**：Claude Code 与 Codex 使用同一 canonical mother Skill；项目共享规则以 `AGENTS.md` 为准。
3. **Evidence First**：所有持久化项目事实都能追溯到 repository evidence。
4. **Minimal Global Context**：只把稳定、全局、不可可靠重发现的规则写入 `AGENTS.md`。
5. **Progressive Disclosure**：全局规则、专项 Skills、Agent docs 和源码按需加载。
6. **可重复运行**：无版本或项目变化时，install、update 与 project reconcile 应 ideally zero diff。
7. **可诊断**：失败结果包含具体路径、原因、当前状态和最小修复建议。
8. **可测试**：核心行为可通过少量稳定 Interface 在 temporary HOME 和 fixture repository 中验证。

### 2.2 实现约束

- Node.js 18+；
- ESM JavaScript；
- 优先 Node.js standard library；
- 无 build step；
- 不引入大型 CLI framework、DI framework、repository parser、rule engine 或索引系统；
- helper script 只收集确定性事实，Agent 负责解释；
- Linux、macOS、WSL 为 v0.1 必须支持的平台；Windows Native best-effort；
- 所有路径由运行时 home directory 与 package location 计算，不硬编码用户目录。

---

## 3. 总体架构

系统分成两个严格分离的执行平面：

```text
Distribution Plane                         Repository Plane
──────────────────                         ────────────────
@apparux/agent-init               project-setup mother Skill
        │                                           │
        ▼                                           ▼
Lightweight Node CLI                         Current repository
        │                                           │
install / update / doctor / uninstall               │
        │                                  explore / propose / apply
        ▼                                           ▼
~/.agent-init/                    AGENTS.md / CLAUDE.md /
        │                                  project Skills / agent docs
        ├──────────────┐
        ▼              ▼
Claude target      Codex target
```

### 3.1 Distribution Plane

Node CLI 只管理本工具拥有的用户级资产：

- stable canonical installation；
- Claude Code 与 Codex discovery targets；
- installation manifest；
- 安装健康检查与生命周期操作。

它不读取或修改当前业务 repository。

### 3.2 Repository Plane

`project-setup` 母 Skill 使用 Agent 能力理解当前 repository：

- 先只读探索；
- 建立 Project Profile 与 Evidence Ledger；
- 分类知识；
- 输出 Proposal；
- 获得明确批准后写入受限项目路径；
- 验证并支持后续 reconcile。

它不管理母 Skill 的安装版本；CLI `update` 与 project reconcile 不得互相替代。

---

## 4. 模块设计

设计优先采用 deep modules：让调用者通过小 Interface 获得完整生命周期行为，把路径判断、所有权、回滚和平台差异隐藏在实现内部。只有存在真实变化点时才建立 Seam。

### 4.1 CLI Runner Module

**职责**

- 解析命令行参数；
- 从 package metadata 读取版本；
- 构造 Runtime Context；
- 调用 Installation Lifecycle Module；
- 将结构化结果渲染到 stdout/stderr；
- 设置 process exit code。

**Interface（概念）**

```text
runCli(argv, runtime) -> exitCode
```

调用者只需要提供参数与运行时上下文，不需要知道 manifest、symlink、copy fallback 或回滚细节。

**命令语法**

```text
agent-init install
agent-init update
agent-init doctor
agent-init uninstall
agent-init --version
agent-init --help
```

无参数或未知参数时输出简洁 usage。`--help` 是辅助行为，不扩大产品职责。

### 4.2 Installation Lifecycle Module

**职责**

完整封装 `install`、`update`、`doctor`、`uninstall` 的状态检查、计划、执行、验证与失败恢复。

**Interface（概念）**

```text
executeLifecycle(request, runtime) -> LifecycleResult
```

`request.operation` 为 `install | update | doctor | uninstall`。`LifecycleResult` 是结构化数据，CLI 文案不是核心逻辑的返回值。

**内部阶段**

```text
Validate immutable request/package inputs（read only）
  ↓
Initial inspect/classify, including control set（read only）
  ↓
Return immediately on obvious conflict/busy/invalid payload（zero mutation）
  ↓
Acquire mutation lock（doctor 除外）
  ↓
Recover or report interrupted operation
  ↓
Re-inspect and classify ownership/health
  ↓
Build Operation Plan
  ↓
Revalidate each asset immediately before mutation
  ↓
Apply Safely（doctor 除外）
  ↓
Validate and commit
  ↓
Return Structured Result
```

初始只读检查用于保证 invalid payload 与已存在的 obvious foreign/conflict 不产生 lock/journal churn；成功获取 lock 后必须重新检查，不能依赖初始 snapshot。完整 operation plan 必须在业务资产持久化修改前完成。Plan 不是永久授权：每个 replace/remove/create 必须在 mutation-time 重新验证 entry type、ownership identity、digest/link text 与 parent identity；验证失败即保留现场并停止该 mutation。exclusive lifecycle lock 只用于串行化本工具进程，不能替代 ownership revalidation。

### 4.3 Managed Target Module

Claude Code target 与 Codex target 共享一套目标管理逻辑。

**Interface（概念）**

```text
inspectTarget(targetSpec, manifestRecord) -> TargetState
materializeTarget(targetSpec, preferredMode) -> TargetRecord
removeOwnedTarget(targetSpec, manifestRecord) -> RemovalResult
```

这里存在真实 Seam，因为有两个实际 Adapter：

1. **Symlink Adapter**：首选；target 指向 canonical mother Skill。
2. **Managed Copy Adapter**：仅在 symlink 无法使用时 fallback；由 manifest、ownership marker 与 payload digest 共同证明所有权。

两种 Adapter 对 lifecycle 调用者呈现相同目标状态，不把平台差异泄漏给命令实现。

### 4.4 Managed Filesystem Module

**职责**

集中处理高风险文件系统行为：

- 逻辑路径与物理路径 containment 检查；
- existing ancestor 的 no-follow inspection；
- deterministic tree digest；
- target-local staging；
- atomic file write；
- directory detach/swap；
- rollback；
- symlink/junction inspection；
- mutation-time ownership revalidation；
- 只删除已证明 owned 的 detached tree。

删除或替换普通目录时，不对刚验证过的 live pathname 直接递归操作：先以 exclusive rename 将其原子 detach 到同 parent 的唯一 quarantine path，再核对 detached object 的 type、ownership marker 与 digest；只有完全匹配才删除或作为 rollback backup。验证失败时保留该对象，且仅在不会覆盖新 entry 时恢复原路径。创建时使用 exclusive create/rename，目的路径意外出现即停止。

该模块不提供通用文件系统包装层。普通读取直接使用 Node 标准库；只有需要统一安全不变量的行为进入该模块，以避免浅层 pass-through。

### 4.5 Manifest Module

**职责**

- 解析、校验与序列化 `install.json`；
- 拒绝未知或损坏 schema；
- 提供 ownership validation 所需记录；
- 原子写入 manifest。

Manifest Module 不修复文件系统，也不推断用户意图。

### 4.6 Project Setup Skill Module

**外部 Interface**

```text
Claude Code: /project-setup
Codex:       $project-setup
```

其 Interface 不只是触发命令，还包括以下行为约束：

- Apply 前必须只读探索并展示 Proposal；
- 未获得明确批准不得写文件；
- 缺少 evidence 的事实必须标记 `Unknown`；
- 默认写入范围仅限 Agent 资产；
- 已有配置必须保留并保守合并；
- 完成后必须输出 validation result。

**内部资料**

`SKILL.md` 保持编排职责，详细规则按需放入 references：

```text
skills/project-setup/
├── SKILL.md
├── references/
│   ├── classification.md
│   ├── agents-guidelines.md
│   ├── skills-guidelines.md
│   ├── detection-guidelines.md
│   ├── proposal-guidelines.md
│   └── reconciliation-guidelines.md
└── scripts/
    └── detect-project.js
```

references 是 Progressive Disclosure 的实现，不应在 `SKILL.md` 中重复全文。

---

## 5. 推荐代码与测试布局

PRD 中的目录是参考而非必须逐文件照搬。v0.1 建议从以下最小布局开始：

```text
agent-init/
├── bin/
│   └── agent-init.js
├── src/
│   ├── cli/
│   │   ├── run.js
│   │   └── output.js
│   └── installation/
│       ├── lifecycle.js
│       ├── targets.js
│       ├── filesystem.js
│       ├── manifest.js
│       └── paths.js
├── skills/
│   └── project-setup/
│       ├── SKILL.md
│       ├── references/
│       └── scripts/
├── tests/
│   ├── cli/
│   ├── installation/
│   ├── project-setup/
│   └── fixtures/
├── package.json
└── package-lock.json
```

约束：

- `bin/` 入口只负责启动，不包含生命周期逻辑；
- 不为每个命令预先创建只有一层转发的浅模块；
- 当 `lifecycle.js` 内出现可独立维护且有明确不变量的职责时再拆分；
- tests 主要穿过 CLI Runner 与 Installation Lifecycle 的 Interface；
- 文件系统测试使用真实 temporary HOME，不用 mock 用户真实 home。

---

## 6. Runtime Context

所有环境依赖由入口解析一次并显式传入：

```text
RuntimeContext
- homeDir
- platform
- packageRoot
- packageName
- packageVersion
- stdout
- stderr
- now()
- randomBytes(size)
```

设计规则：

- `homeDir` 使用 Node home-directory resolution，并验证为可解析的绝对路径；运行时同时保留 logical home（仅用于展示）与启动时解析的 physical home anchor；
- 所有 managed path 既要通过 lexical containment，也要通过 physical containment；对已存在 ancestor 逐段 no-follow inspection，拒绝 link loop 与逃逸；
- v0.1 拒绝 tool root 内部的 symlink/junction/reparse ancestor；对 `.agents`、`.claude` 及其 `skills` parent 也采用保守策略：若 existing parent 是 link/reparse point，则停止并报告，不穿透写入；
- 路径相等使用平台感知规则；Windows 必须处理 drive/UNC/case 与 junction，relative symlink 必须相对 link parent 解析；
- `packageRoot` 从入口模块位置解析，不依赖 current working directory；
- `packageVersion` 只从 package metadata 读取，不维护第二份常量；
- `now()` 可由测试注入，确保 manifest 与输出可重复；
- `randomBytes()` 可由测试注入固定值，生产运行必须使用 Node cryptographic RNG 生成 operation/install/target identity；
- lifecycle 不读取业务 repository 的 cwd。

缺失的 `~/.agents`、`~/.agents/skills`、`~/.claude`、`~/.claude/skills` 可以逐级创建，但这些 parent 永远不进入永久 ownership。当前 transaction 只临时记录其创建事实；rollback 仅对本次创建且仍为空的目录执行 non-recursive `rmdir`，uninstall 永不删除这些 parent。

文件系统测试使用 Node 原生文件系统与 temporary HOME，因此不额外建立只有测试 fake 才需要的 Filesystem Seam。

---

## 7. Stable Installation Layout

正式安装布局：

```text
~/.agent-init.operation.lock                 # fixed atomic lock entry；健康 idle 状态不存在
~/.agent-init.operation-<id>.owner.json      # immutable descriptor
~/.agent-init.operation-<id>.journal.json    # atomically replaced journal

~/.agent-init/
├── current/
│   ├── .agent-init-owner.json
│   └── skills/
│       └── project-setup/
│           ├── SKILL.md
│           ├── references/
│           └── scripts/
└── install.json
```

Lifecycle control set 必须位于 removable installation root 之外，否则 fresh install 无法在不触碰 foreign root 的情况下加锁，uninstall 也无法在持锁时删除 root。固定 lock entry 是指向 immutable descriptor 的 atomic no-replace hard link（或具备同等 no-replace + crash-atomic 语义的平台 primitive）；不支持该 primitive 时 fail safely，不使用 torn-write 风险更高的 fallback。健康 idle 状态不存在 fixed lock。若 fixed lock 已存在：descriptor/schema/identity 无效则视为 foreign/ambiguous，绝不覆盖或删除；owner active 则 busy；只有 descriptor 有效且能确认 owner 不再存活时才进入 stale recovery。

Discovery targets：

```text
~/.agents/skills/project-setup
~/.claude/skills/project-setup
```

目标默认指向：

```text
~/.agent-init/current/skills/project-setup
```

### 7.1 Staging、journal 与 rollback

Canonical payload 在 installation root 所在文件系统 staging；每个 managed-copy target 则必须在自身 physical parent 下使用唯一 sibling staging/quarantine，避免跨 filesystem rename 与 `EXDEV` 后退化为 live in-place copy：

```text
~/.agent-init/.staging-<operation-id>/
~/.agent-init/.rollback-<operation-id>/
<target-parent>/.project-setup-staging-<operation-id>/
<target-parent>/.project-setup-rollback-<operation-id>/
```

多资产操作使用 installation root 外的 control set 作为 exclusive lifecycle lock + 小型 durable JSON journal（不是大型 transaction framework）。协议为：

1. 在 home parent 内写入 operation-bound owner descriptor 与初始 journal temp，`fsync` 文件后以 atomic rename 发布完整文件，再在平台支持时 `fsync` parent；平台不支持 directory `fsync` 时明确记录 weaker crash-durability，并在发布前验证 rename/no-replace guarantees，不假装已获得更强语义；
2. 仅在 descriptor/journal 都完整后，以 atomic no-replace primitive 发布 fixed lock；因此 fixed lock 不会指向半写 JSON；
3. 每次 journal 更新都写入新的 operation-bound temp，`fsync` 后 atomic replace，不复用 live journal inode，不做 in-place truncate/write；
4. 每个 persistent mutation 采用 write-ahead protocol：先原子发布 intent，再执行 mutation，再原子发布 completion；restart 根据 journal 与实际 fingerprints 判定尚未执行、已执行或 evidence mismatch；
5. fixed lock 是 authoritative owner reference。无 fixed lock 的 orphan temp/descriptor/journal 绝不自动删除；只有其名称包含当前操作生成的 cryptographic id 且被当前 journal 明确列为本次资产时，才可清理。其他 orphan 只由 doctor 报告并人工处理。

Journal 至少记录 process ownership evidence、operation id/type、previous/proposed manifest generation、old/new fingerprints、当前 durable phase、staged/quarantined paths 与 commit point。

任一 mutating command 启动时必须先处理 control set：

- uncommitted 且 evidence 完整：回滚；
- committed 但 cleanup 未完成：只完成 cleanup；
- evidence 不匹配：保留可疑资产并报告 `ambiguous`，不猜测；
- active owner 存在：报告 busy；
- stale fixed lock 只有在确认无 active owner 且 descriptor/journal schema/identity 有效后，才按 recovery 规则处理；
- foreign/invalid fixed lock 或 descriptor/journal：报告 ambiguous，零修改。

成功后最后清理 journal/descriptor/fixed lock/staging/rollback。Uninstall 在 fixed lock 仍持有 serialization 与 recovery evidence时移除 installation root，验证完成后再删除外部 control set。失败时优先恢复上一个已验证状态；如果恢复不完整，保留诊断所需状态并明确报告，不声称成功。`doctor` 保持只读，只报告 `busy`、`recoverable` 或 `ambiguous` 及 remediation。

### 7.2 Canonical payload 校验

创建 control set 或执行任何其他修改前，必须只读验证 npm package 内：

- `skills/project-setup/SKILL.md` 存在且可读；
- payload 只包含支持的文件类型；
- package name 与 version 可读；
- source tree digest 可计算；
- `SKILL.md` frontmatter 至少含 `name: project-setup` 与可用 description，且 directory/name 一致。

无效 package payload 不得触碰现有安装。安装时为 canonical root 写入与 manifest `installId` 匹配、且不属于 mother Skill payload 的 reserved ownership marker；canonical ownership validation 必须同时检查 marker identity 与 payload digest。

---

## 8. Installation Manifest

`~/.agent-init/install.json` 是生命周期状态与 ownership evidence，不是配置中心。

建议 schema：

```json
{
  "schemaVersion": 1,
  "package": "@apparux/agent-init",
  "version": "0.1.0",
  "installId": "<opaque installation id>",
  "installedAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>",
  "installRoot": "<absolute path>",
  "canonical": {
    "root": "<absolute path to ~/.agent-init/current>",
    "skillPath": "<absolute path to current/skills/project-setup>",
    "digest": "sha256:<payload digest>"
  },
  "targets": {
    "codex": {
      "path": "<absolute path>",
      "mode": "symlink",
      "source": "<absolute path>",
      "targetId": "<opaque target id>",
      "entryIdentity": "<stable no-follow platform identity>",
      "digest": null
    },
    "claude": {
      "path": "<absolute path>",
      "mode": "copy",
      "source": "<absolute path>",
      "targetId": "<opaque target id>",
      "entryIdentity": "<stable no-follow platform identity or null for copy>",
      "digest": "sha256:<digest>"
    }
  }
}
```

### 8.1 Schema 规则

- `schemaVersion` 必须被当前 CLI 明确支持；
- `package` 必须匹配当前产品；
- `installId` 与每个 `targetId` 是安装时使用 cryptographically strong random bytes 生成的 opaque ownership identity；它们不是 credential，但不得使用可预测 counter/time 代替；
- 所有 managed path 必须为预期 home 下的绝对路径，并同时通过 logical/physical containment；
- `installRoot` 必须等于当前 home 推导出的 stable root；
- symlink target 的 `source` 必须等于 canonical path，并且平台必须提供可持久比较的 stable no-follow `entryIdentity`；由于 symlink 内不能安全嵌入 marker，manifest record、link text/destination 与 stable identity 必须同时匹配。平台不能提供 stable identity 时，本次 install/update 不使用 managed symlink，直接采用 managed-copy fallback；existing identity-less symlink record 在 destructive operation 中视为 ambiguous 并保留；
- managed copy 必须包含不参与 payload digest 的 installer-reserved ownership marker，并记录 matching `installId` / `targetId` 与 digest；
- marker 缺失或 identity 不匹配时不得以内容相同认定 ownership；
- 不记录 API key、token、credential、repository secret 或 repository-specific data；
- manifest 通过临时文件加 rename 原子替换。

### 8.2 Tree digest

Digest 使用 SHA-256，输入包含：

- 按规范化 relative path 排序的文件清单；
- entry type；
- 文件内容；
- 需要保留的 executable bit。

不包含 mtime、absolute path 或目录遍历顺序，确保不同机器上的相同 payload 得到相同结果。遇到不支持的 entry type 时快速失败。

---

## 9. Ownership 与健康状态模型

每个 managed asset 被分类为以下状态之一：

| 状态 | 含义 | 默认动作 |
|---|---|---|
| `missing` | 路径不存在 | 可按已验证计划创建或修复 |
| `owned-valid` | manifest 与实际内容一致 | 保留、更新或安全删除 |
| `owned-broken` | ownership identity 仍可证明，且 breakage 不可能由普通 payload edit 产生（例如 link entry 未变但 source 缺失），或 breakage 被 durable journal 明确证明来自 interrupted operation | doctor 报错；install/update 可安全修复；uninstall 仅移除上述可独立证明的残留 entry |
| `owned-drifted` | manifest 指向该资产，但内容或 link destination 已被改变 | 不覆盖、不删除；报告冲突 |
| `foreign` | 路径存在但没有本工具 ownership evidence | 停止冲突操作 |
| `ambiguous` | manifest 损坏、路径逃逸或无法证明归属 | 停止并要求人工处理 |

### 9.1 Symlink ownership

只有同时满足以下条件才是 `owned-valid`：

- manifest 记录该 target 为 `symlink`；
- target 自身确实是 symlink；
- 规范化后的 link destination 精确等于 canonical path；
- stable no-follow entry identity 与 manifest record 一致；identity-less symlink 不得成为 `owned-valid`，destructive operation 必须保留；
- canonical ownership marker 与 payload digest 均与 manifest 一致。

不得通过跟随 link 后“内容相同”来认定 ownership，因为 link 可能属于用户。

### 9.2 Managed copy ownership

只有同时满足以下条件才是 `owned-valid`：

- manifest 记录该 target 为 `copy`；
- target 为普通目录而非 symlink；
- installer-reserved marker 中的 `installId` / `targetId` 与 manifest 完全一致；
- 排除 marker 后的 deterministic payload digest 与 manifest 完全一致。

只有 type + digest 而没有 matching marker，不足以证明 ownership；字节相同但由用户重新创建的目录必须保留。除非 active/stale durable journal 能逐项证明 mismatch 来自本工具 interrupted mutation，否则任何 managed-copy payload mismatch（即使 marker 仍匹配）都进入 `owned-drifted` 或 `ambiguous`，update 与 uninstall 均不得静默覆盖或删除。普通 payload 缺失不能仅凭 marker 被降格为可删除的 `owned-broken`。

### 9.3 Installation root ownership

- root 不存在：fresh install 可创建；
- root 存在但无有效 manifest：非空时视为 ambiguous，不接管；若 root 物理上为空，则可将其视为 interrupted uninstall residue，仅允许 non-recursive `rmdir`（失败即保留），不得据此接管任何内容；
- root 含 manifest 未记录的未知顶层资产：uninstall 不递归删除 root；
- canonical ownership marker 缺失/不匹配或 payload digest 漂移：update/uninstall 停止并报告；
- 只清理由当前操作创建、且名称与位置均通过 containment 检查的 staging/rollback 资产。

---

## 10. Lifecycle 操作设计

### 10.1 Install

```text
Validate package payload
  ↓
Inspect stable root, manifest and both targets
  ↓
Classify ownership and conflicts
  ↓
Build complete install/repair plan
  ↓
Stage canonical payload
  ↓
Install canonical payload
  ↓
Materialize Codex and Claude targets
  ↓
Write manifest atomically
  ↓
Validate installed state
```

行为：

- fresh state：安装；
- 同版本且健康：no-op，输出 Already installed；
- 同版本且 ownership 可证明但 managed asset 缺失：安全修复；
- 已安装版本与当前运行 package 不同：不把 `install` 隐式当作 update，提示使用 `update`；
- 任一 target 为 foreign/ambiguous/owned-drifted：在修改前停止；
- symlink 创建因明确的平台能力限制失败时才 fallback managed copy；
- partial failure 时只回滚当前运行创建或替换的 owned assets。

### 10.2 Update

```text
Validate package payload
  ↓
Read and validate manifest
  ↓
Verify ownership of canonical payload and targets
  ↓
Compare running and installed versions/digests
  ↓
Stage new canonical payload
  ↓
Swap canonical payload with rollback copy
  ↓
Repair symlinks / replace owned managed copies
  ↓
Write updated manifest atomically
  ↓
Validate
  ↓
Remove rollback assets
```

行为：

| Running package 与 installed version/payload | 行为 |
|---|---|
| running version 较新 | 允许按安全计划 upgrade |
| version 相同且 package digest 相同 | 健康则 `Already up to date.`；owned asset 缺失/损坏则 repair |
| version 相同但 package digest 不同 | integrity conflict，零修改并提示使用明确的新版本发布 |
| running version 较旧 | 拒绝 downgrade，零修改并提示使用 `npx @apparux/agent-init@latest update` |
| version 无法按支持的语义比较 | 停止并报告 manifest/package metadata error |

foreign、ambiguous 或 drifted asset 不更新；update 永远不扫描或修改业务 repository。每个 canonical/target/manifest mutation 前重新验证 plan fingerprint 与 ownership identity；更新失败时根据 durable journal 恢复旧 canonical payload、managed copies 与旧 manifest。v0.1 不提供 force/downgrade 开关。版本比较只发生在 running package 与 installed manifest 之间；CLI 不自行查询 registry，因此 global-install 用户要获取最新 payload，必须使用 PRD 推荐的 `npx @apparux/agent-init@latest update` 或先更新 global package。

### 10.3 Doctor

Doctor 完全只读，检查：

- home/platform resolution；
- manifest 存在性、schema 与路径；
- installed/running version；
- canonical directory、`SKILL.md` 与 digest；
- Codex target；
- Claude target；
- symlink destination 或 managed copy digest；
- read permissions；
- stale staging/rollback；
- ownership consistency。

每个 check 返回：

```text
id + status(ok|warning|error) + path + message + remediation
```

整体状态：存在 error 时 exit code 1，否则 0。Doctor 不自动修复。

### 10.4 Uninstall

```text
Read and validate manifest
  ↓
Inspect canonical payload and both targets
  ↓
Build removal plan
  ↓
Revalidate, detach and remove independently owned targets
  ↓
Revalidate, detach and remove verified canonical payload and manifest
  ↓
Remove empty tool root
  ↓
Validate absence/preservation
```

行为：

- 每个 target 在 mutation-time 独立 revalidate；`owned-valid` 以及 unchanged link/source-missing 或 journal-proven interruption 这类 `owned-broken` 可安全 detach/remove；managed-copy 普通 payload mismatch 必须保留；
- target 已被用户替换：保留 target；该 target 的冲突不阻止移除其他彼此独立、仍可证明 owned 的资产；
- foreign target 与 install root 无关：保留 target，可继续删除另一个 owned target 与已验证 tool-owned root；
- ambiguous target 指向 install root，或 root/canonical 含未知/漂移内容：停止所有依赖该 ownership chain、可能导致数据损失的删除；
- detach 后必须再次验证 detached object，才允许递归删除；
- project assets 与 target parent directories 永远不在 uninstall 搜索或删除范围内；
- 已卸载状态返回清晰 no-op，不作为错误；
- 卸载结果必须列出 removed、preserved 和 unresolved assets。

### 10.5 Version

- 直接读取 package metadata；
- 输出 `agent-init <version>`；
- 不读取 manifest，不要求已安装；
- 不维护独立版本常量。

---

## 11. Symlink Fallback 策略

首选 symlink，因为它天然保持单一 canonical source。

### 11.1 尝试顺序

1. 验证 target parent 的 physical containment，且 target 不存在或属于可修复的 managed target；
2. 先确认平台/filesystem 能提供可持久比较的 stable no-follow identity；满足时 macOS/Linux/WSL 尝试 directory symlink；
3. Windows Native 仅在所用 directory link/junction 方式也能提供 stable no-follow identity 时 best-effort 尝试，并在 manifest 中明确记录实际 link mode；
4. identity 不可用，或明确的 symlink capability error，均启用 managed copy fallback；
5. 在 target physical parent 下构建完整 sibling staging copy，写入 ownership marker 并计算 payload digest；
6. mutation-time 再次确认 target state；通过 exclusive rename 提升 staging，不允许 `EXDEV` 后原地覆盖；
7. 写入 manifest record；失败时按 journal 恢复或保留可诊断状态。

普通 parent permission failure 不应伪装成 symlink capability 问题；如果 copy 同样不可写，应返回 permission error，并保留原始 symlink error 作为上下文。

### 11.2 Cross-agent 一致性

两个 target 可以分别使用不同 mode，但都必须来自同一 canonical payload 与版本。Doctor 应显示每个 target 的 mode。

---

## 12. CLI 输出与错误模型

### 12.1 Exit codes

| Code | 含义 |
|---|---|
| `0` | 操作成功、健康、no-op 或 help/version 成功 |
| `1` | 操作失败或 doctor unhealthy |
| `2` | 命令用法错误 |

v0.1 不引入更多不稳定的细粒度 exit code。

### 12.2 错误类别

内部至少区分：

- `USAGE_ERROR`
- `INVALID_HOME`
- `PERMISSION_DENIED`
- `INSTALL_CONFLICT`
- `CORRUPT_MANIFEST`
- `UNSUPPORTED_MANIFEST`
- `PARTIAL_INSTALLATION`
- `MISSING_CANONICAL_SKILL`
- `BUSY_OPERATION`
- `RECOVERABLE_OPERATION`
- `AMBIGUOUS_OPERATION`
- `PHYSICAL_PATH_ESCAPE`
- `INTEGRITY_CONFLICT`
- `DOWNGRADE_REFUSED`
- `BROKEN_TARGET`
- `OWNERSHIP_MISMATCH`
- `MANAGED_COPY_DRIFT`
- `ROLLBACK_FAILED`

每个用户可见错误必须包含：

```text
What failed
Where it failed
Why it is unsafe to continue
What was changed, if anything
Recommended next action
```

默认不打印 stack trace；测试通过结构化 error code 断言，CLI 展示稳定文案。

### 12.3 输出结构

成功输出只展示：版本、关键路径、target mode/status、结果和下一步命令。底层 copy/rename 调试日志不默认输出。

---

## 13. Project Setup Skill 工作流

### Phase 0 — Preflight

收集：

- cwd 与 repository root；
- 是否为 Git repository；
- staged、unstaged、untracked 状态及其 preflight baseline（如 Git 可用）；
- 已有 Agent 配置与 Skill directories；
- 用户请求范围。

非 Git repository 不阻塞 setup，但必须使用文件 baseline fingerprint 保护写入。Dirty repository 也不阻塞：Validation 比较的是 **final state 相对 preflight baseline 的新增 delta**，不是要求最终 working tree clean。预先存在的 staged/unstaged/untracked business entries 必须保持内容与状态不变；若 Agent 配置正在被修改，进入保守模式，不覆盖。

### Phase 1 — Explore（严格只读）

按以下顺序探索：

```text
Search for indicators
  ↓
Read relevant files
  ↓
Cross-check independent evidence
  ↓
Record evidence and unknowns
```

重点覆盖 repository shape、languages、runtime、build、CI/verification、docs、existing agent configuration 与项目特有 workflow。禁止为“完整”而读取整个 repository。

探索不得读取或持久化 credential value、private key 或 secret；敏感文件默认只检测存在性，除非用户明确授权且任务确实需要。

### Phase 2 — Build Project Profile

Project Profile 是运行时中间数据，默认不持久化：

```text
ProjectProfile
- repository: root, git state, single/monorepo shape
- languages
- runtimes
- build systems and package managers
- frameworks and persistence indicators
- modules/packages
- verification commands
- existing agent assets
- unknowns
```

每个非 Unknown 结论必须引用 Evidence Ledger。

### Phase 3 — Classify Knowledge

分类采用两个维度，避免把“存在哪里”与“能否程序化执行”混为一谈：

**Persistence scope（恰好一个主要值）**

| Scope | 判定 | Destination |
|---|---|---|
| `GLOBAL` | 长期稳定、绝大多数任务需要；即使 evidence 文件可搜索，Agent 仍需在行动前知道该约束 | `AGENTS.md` |
| `WORKFLOW` | 特定任务才需要、重复出现、项目特有，且需要步骤/验证而非只有事实 | `.agents/skills/<skill>/` |
| `DISCOVERABLE` | 任务局部实现事实，可从源码可靠重发现，且没有独立 policy/workflow/architecture 持久价值 | 不持久化 |
| `ARCHITECTURE` | 长期有价值但不应常驻 Global Context | `docs/agents/`，`AGENTS.md` 仅放入口 |
| `NONE` | 无充分持久价值或 evidence | 不持久化 |

**Enforcement flag（独立、可选）**

`deterministicEnforcementCandidate: true` 表示该规则可由 Hook、script、CI check 或 permission 稳定执行。v0.1 只在 Proposal 中产生 guardrail `RECOMMEND`，但这不会取代其 `GLOBAL` 或 `WORKFLOW` 持久 scope。例如“统一使用 pnpm”可同时是 `GLOBAL` 与 deterministic candidate。

判定顺序：

1. 无充分 evidence → `Unknown` / `NONE`，不持久化；
2. 先判断是否存在 repository-wide policy、专项 workflow 或长期 architecture 价值；
3. 只有任务局部、可可靠重发现且无上述持久价值的事实才是 `DISCOVERABLE`；
4. 满足 stable + broad + pre-action relevance 的 policy → `GLOBAL`；
5. 满足 task-specific + repeated + procedural/verification value → `WORKFLOW`；
6. 长期 architecture explanation → `ARCHITECTURE`；
7. 独立判断是否设置 deterministic enforcement flag。

不要仅因检测到技术栈而创建 Skill 或全局规则。

### Phase 4 — Detect Project Skills

Skill candidate 必须同时满足：

- 有 repository evidence；
- 对明确任务类型有触发条件；
- 是项目特有且预计重复使用的 workflow；
- 需要超过几条全局规则的专项说明；
- 可以定义明确 verification；
- 不只是技术栈标签或源码目录摘要。

不满足时明确 `SKIP` 并给出原因。

### Phase 5 — Generate Proposal

任何项目文件写入前输出完整 Proposal。Proposal 包含：

```text
- detected project summary
- evidence-backed facts
- unknowns and warnings
- CREATE / UPDATE / KEEP / SKIP / RECOMMEND actions
- exact target paths
- concise proposed content or diff
- evidence and reason for each action
- baseline fingerprint for every writable target
- explicit non-goals / files that will not change
- validation plan
```

批准针对 Proposal 的精确版本。用户要求调整时先生成修订版 Proposal；不得把模糊认可解释为扩大写入范围。

### Phase 6 — Apply

默认允许写入：

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
docs/agents/
```

应用前重新读取所有 target 并比较 baseline fingerprint；任一 target 已改变时停止并重新提案。除 lexical allowlist 外，必须逐段 no-follow 检查 repository root 到 target parent 的 existing ancestors；`.agents`、`.claude`、`docs/agents` 或其 ancestor 若为 symlink/junction/reparse point，v0.1 默认停止并报告，不沿其写出 repository physical root。Apply 只执行已批准的 `CREATE` / `UPDATE`，不执行 `RECOMMEND`。

写入顺序：

1. `AGENTS.md`；
2. `CLAUDE.md` adapter；
3. canonical project Skills；
4. Claude Skill references/copies；
5. approved `docs/agents/`；
6. validation。

若中途失败，报告已经改变与尚未改变的文件；不对用户文件做未经批准的自动回滚。

### Phase 7 — Validate

至少验证：

- 实际改动与 approved Proposal 一致；
- 未修改 forbidden business paths、CI、manifest、database 或 production config；
- `AGENTS.md` 内容 minimal、稳定且可追溯；
- `CLAUDE.md` 复用 `@AGENTS.md`，不复制共享规则；
- 每个 project Skill 聚焦且 evidence-based；
- `.claude/skills` 引用 canonical `.agents/skills` 或明确记录 copy fallback；
- 已有用户内容仍存在；
- unknown 未被改写为猜测；
- 再次 dry-run reconcile ideally 产生零写入 action；
- Git 可用时，将 final state 与 preflight baseline 比较：只有 approved paths 可以出现新增 delta，且 pre-existing staged/unstaged/untracked entries 的内容与状态保持不变。

---

## 14. Evidence Ledger 与运行时数据模型

### 14.1 Evidence Record

```text
EvidenceRecord
- id
- fact
- sourcePath
- sourceLocation or key
- observation
- whyItMatters
- persistenceScope or Unknown
- deterministicEnforcementCandidate
- destination or none
```

规则：

- source path 使用 repository-relative path；
- observation 与 interpretation 分开；
- 一条持久化事实至少有一条直接 evidence；
- 存在冲突 evidence 时记录冲突，不自行选择更方便的结论；
- evidence 只在 Proposal 中按需展示，MVP 不要求写入永久数据库。

### 14.2 Proposal Action

```text
ProposalAction
- action: CREATE | UPDATE | KEEP | SKIP | RECOMMEND
- target
- reason
- evidenceIds
- proposedContent (CREATE only)
- proposedDiff (UPDATE only)
- summary (KEEP | SKIP | RECOMMEND)
- decisionRequired
- baselineFingerprint
- validation
```

`CREATE` 必须展示完整 proposed content；`UPDATE` 必须展示 exact proposed diff，不能只给 summary。`KEEP`、`SKIP`、`RECOMMEND` 永远不直接产生写操作。需要用户决定且尚未安全收敛时，用 warning + `decisionRequired` 表示，不增加第六种 action；任何修订都生成新 Proposal 并使旧 approval 失效。

### 14.3 Baseline fingerprint

对已有普通文件使用内容 SHA-256；对目录使用 deterministic tree digest；对 symlink 使用 link text 与规范化 destination。不存在的 target 使用显式 `missing` marker。它只保护本次 Proposal 到 Apply 的竞态，不作为永久 ownership manifest。

---

## 15. 生成资产设计

### 15.1 `AGENTS.md`

`AGENTS.md` 是共享 Source of Truth。建议仅在有内容时包含：

```text
# Repository Rules
## Environment
## Working Principles
## Verification
## Project Knowledge
## Safety
```

限制：

- 不复制完整项目简介或目录树；
- 不枚举所有 dependency/module/class/method；
- 不保存瞬时实现位置；
- 不写无 evidence 的通用“最佳实践”；
- 对 architecture docs 与 Skills 只提供短入口。

### 15.2 `CLAUDE.md`

默认仅为：

```markdown
@AGENTS.md
```

只有存在 Claude Code 专属、且有 evidence 的规则时才追加专属段落。不得复制 `AGENTS.md` 共享内容。

### 15.3 Project Skills

所有 mother/project `SKILL.md` 采用两种 Harness 均能发现的共享最小格式：

```yaml
---
name: <lowercase-hyphen-directory-name>
description: <what the Skill does and when to use it>
---
```

`name` 必须与 Skill directory 完全一致；共享 canonical Skill 默认只使用双方共同支持的 metadata field。若未来确需 harness-specific metadata，必须放入明确 Adapter，不污染 canonical source。生成或安装前先做静态 metadata validation，再做真实 Harness discovery acceptance。

Canonical source：

```text
.agents/skills/<skill>/SKILL.md
```

Claude discovery target：

```text
.claude/skills/<skill>
```

优先建立指向 canonical source 的 relative symlink；不可用时才创建 proposal-visible managed copy。Project Skills 不使用用户级 `install.json`，每次 reconcile 都通过内容比较、现有意图理解和用户批准保守维护。

每个 Skill 主要包含：

- When to use；
- When not to use；
- Workflow；
- Project-specific rules；
- Verification；
- References。

### 15.4 Agent documentation

只有 `ARCHITECTURE` knowledge 具有持续价值且无法放入更小现有文档时，才创建 `docs/agents/` 文件。`AGENTS.md` 只放按需入口。不得为了匹配推荐目录而创建空文档。

### 15.5 Guardrail recommendations

v0.1 只 Detect → Explain → Recommend。Proposal 必须说明：

- 可确定性执行的规则；
- supporting evidence；
- 推荐 mechanism（Hook、script、CI check 或 permission）；
- 预期影响与误报风险。

Apply 不安装 Hook，不改 CI，不改用户默认行为。

### 15.6 Architecture observations

可以描述 module seams、coupling、public interfaces 与 hotspots，并提出 Deep Module recommendation；不得移动类、创建业务模块或重构生产代码。任何重构都必须成为独立任务。

---

## 16. Existing Configuration Preservation 与 Reconciliation

### 16.1 Preservation

已有 `AGENTS.md`、`AGENTS.override.md`、`CLAUDE.md`、`CLAUDE.local.md`、Skills、`.claude` Hooks/settings、agent docs、`.cursor/` 或 `.github/copilot-instructions.md` 时：

```text
Read Existing
  ↓
Infer documented intent from content and history available locally
  ↓
Compare with evidence-backed desired state
  ↓
Identify conflicts
  ↓
Show proposed diff
  ↓
Merge only after approval
```

禁止 delete-and-regenerate。无法安全合并时输出 `KEEP` 或 `RECOMMEND`，并说明需要用户决定的冲突。

### 16.2 Reconcile

后续 `/project-setup` 或 `$project-setup` 使用同一完整工作流，不建立独立更新器：

- 重新探索当前事实；
- 比较现有 Agent assets；
- 只针对有 evidence 的变化提案；
- 不改写等价文案、不重排无关 Markdown；
- 没有变化时输出 no-op Proposal/summary，零文件修改。

### 16.3 Tool update 与 project reconcile

| 操作 | 管理对象 | 禁止触碰 |
|---|---|---|
| CLI `update` | 用户级 mother Skill 与 discovery targets | 任意业务 repository asset |
| `/project-setup` / `$project-setup` | 当前 repository 的 Agent assets | 用户级安装、业务源码、CI、Hook 默认行为 |

---

## 17. Deterministic Helper Script

`detect-project.js` 是可选但推荐的小型 read-only fact collector。

**Interface（概念）**

```text
node detect-project.js [repository-root]
stdout: one versioned JSON document
stderr: contextual diagnostics
exit: 0 success, non-zero unreadable/invalid root
```

建议输出：

```text
- schemaVersion
- resolved root
- Git presence/root/status summary
- known build files and lock files
- package manifests and exact script names
- language/runtime indicator files
- CI configuration paths
- existing Agent configuration paths
- known Skill directories
- per-check read errors
```

限制：

- 不写任何文件；
- 不判断业务架构好坏；
- 不决定 knowledge classification；
- 不决定 `AGENTS.md` 或 Skill 内容；
- 不递归读取整个 repository；
- 不读取 secret values；
- 输出顺序稳定，便于 fixture tests。

---

## 18. 安全与隐私不变量

1. 所有 destructive filesystem action 前执行路径 containment 与 ownership validation。
2. 不跟随未知 symlink 做删除或覆盖。
3. 不以“内容看起来相似”接管 foreign target。
4. 不在 manifest、Proposal 或生成文档中保存 credentials/secrets。
5. 不静默修复用户可能拥有的数据。
6. Project Apply 必须由明确 Proposal approval 解锁。
7. Proposal 与 Apply 之间发生 target drift 时，批准失效。
8. Distribution mutation allowlist 仅包括：外部 fixed lock、operation-bound descriptor/journal/temp control entries、tool root、两个 exact discovery targets、与 operation id 绑定的 target-parent-local sibling staging/quarantine entries，以及创建缺失 target parent / 回滚本次创建且仍为空 parent 所需的窄 `mkdir`/non-recursive `rmdir`。禁止修改 parent 中任何其他 entry，uninstall 永不删除 parent。
9. Project Setup 默认写入范围固定在 PRD 允许的 Agent asset paths，并要求 physical target 位于 repository root 内。
10. 每个 destructive mutation 使用 mutation-time identity revalidation 与 detach-before-delete；preflight classification 不能单独授权删除。
11. interrupted lifecycle 通过 durable journal 恢复或保守停机，不把 mixed state 当作普通 drift 静默处理。
12. 失败时优先保留数据并报告 partial state，而不是追求“完成”。

---

## 19. 测试策略

### 19.1 CLI 与 installation tests

使用 Node 内置 test runner（除非实现阶段发现充分理由调整）和真实 temporary HOME。每个测试：

- 创建独立 temp directory；
- 注入固定 package payload、version 与 clock；
- 不访问开发者真实 `~/.agents`、`~/.claude`；
- 操作后断言文件系统状态、manifest、output 与 exit code；
- 完成后清理 temp directory。

核心场景：

- fresh install；
- repeat install no-op；
- same-version repair；
- unknown target conflict；
- version upgrade、downgrade refusal、same-version different-payload conflict；
- same-version update no-op，并断言 invocation 前后无 control-set/staging churn；
- healthy/unhealthy/busy/recoverable doctor；
- broken symlink；
- symlink fallback to managed copy；
- managed copy update、marker mismatch、byte-identical user replacement；
- managed copy drift；
- permission failure 与 `EXDEV`；
- corrupt/unsupported manifest；
- in-process partial failure and rollback；
- subprocess 在每个 durable mutation 后强制终止，再 doctor/retry 验证收敛；
- lifecycle mutation 前后 replacement race 与同 HOME concurrent commands；
- uninstall、unchanged-link/journal-proven owned-broken cleanup、managed-copy drift preservation、independent partial continuation；
- target replacement before and between plan/apply；
- symlinked/junction HOME or parent、ancestor retarget、link loop 与 path case variants；
- unknown file under install root；
- target parent pre-existing/missing/file/link/concurrent child creation；
- no repository files changed by CLI commands；
- version comes from package metadata。

每个 lifecycle test 都在 managed roots 周围种入 user-owned sentinel，并在 success、failure、conflict、race、crash 与 retry 后断言所有 foreign entry 的 content、entry type、link text 与 relevant mode bits 不变。跨平台 spawned-process tests 必须隔离该平台实际 home resolution 使用的全部环境变量，而不只是设置 `$HOME`。

优先通过 CLI Runner 和 Installation Lifecycle Interface 测试；仅对 digest、path containment、manifest validation 等稳定纯逻辑增加窄测试。

### 19.2 Project Setup fixture tests

Fixtures 至少覆盖 PRD 指定场景：

```text
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

断言重点是行为，不要求 Agent 每次生成逐字相同文本：

- detection correctness；
- classification correctness；
- evidence traceability；
- scope correctness；
- preservation of AGENTS/CLAUDE/Skills/Hooks/agent docs/override/local/other agent instructions；
- dirty-repository delta relative to preflight baseline；
- physical containment through project target ancestors；
- forbidden behavior absence；
- cross-agent sharing；
- explicit Unknown；
- idempotent second run；
- proposal-before-write。

### 19.3 Platform validation

自动化测试覆盖 path separator、relative/absolute symlink、managed copy、physical ancestor policy 与平台实际 home resolution。发布前至少在 Linux 与 macOS 执行完整 suite；WSL 执行 smoke test；Windows Native 执行 best-effort install/doctor/uninstall，并记录 fallback 结果。spawned CLI 必须隔离 `HOME`、`USERPROFILE`、`HOMEDRIVE`/`HOMEPATH` 等该平台会参与 home resolution 的变量，并先验证 CLI 实际解析出的 home 位于 disposable root。

---

## 20. 验证与发布门槛

v0.1 发布前必须满足：

1. `npm pack` 产物只包含预期 `bin`、`src`、`skills` 与必要 metadata；
2. 从 tarball 使用 temporary HOME 完成 install → doctor → update/no-op → uninstall；
3. 静态 Skill metadata validation 通过；使用 temporary HOME 验证 stable canonical mother Skill、两个 discovery target 与 manifest 记录加载相同 canonical version/content，不要求登录或启动 live Harness；
4. uninstall 后 project fixture assets 与 temporary HOME 中所有 foreign sentinels 保持不变；
5. recorded-run evaluator 在代表性 fixture 上覆盖 no-approval Proposal 与零写入路径，并至少由一个 conforming oracle 覆盖 explore → proposal → approved apply → validate；
6. approved apply 生成固定 project Skill 后，验证其 physical file state、metadata contract 与 `.agents/skills/<skill>` canonical content 一致；
7. 对未变化 fixture 再次运行 ideally zero diff；
8. PRD AC-D01–AC-D13 与 AC-P01–AC-P18 均有自动化测试或明确的人工验证记录；
9. 所有失败场景都给出可执行 remediation；
10. 无 unresolved data-loss、ownership 或 scope violation。

---

## 21. 关键设计决策

### D-01：一个 lifecycle Interface，而不是每个命令一套独立实现

原因：install、update、doctor、uninstall 共享状态检查与 ownership 规则。集中实现提供 locality，避免四套逻辑漂移；CLI command handler 保持浅入口但不复制策略。

### D-02：使用 manifest + 实际文件系统证据共同证明 ownership

原因：仅有路径记录不足以证明用户未替换 target；仅比较内容又可能误接管用户文件。canonical/managed-copy ownership marker、symlink no-follow entry identity、link destination 与 payload digest 共同提供保守判定。

### D-03：文件系统测试使用 temporary HOME，而不是大规模 mock

原因：symlink、rename、permission、path normalization 与 digest 是核心行为。真实临时文件系统更接近 Interface 的实际语义，也符合 PRD 禁止触碰真实 home 的要求。

### D-04：Project Proposal 使用 baseline fingerprint

原因：Proposal approval 与 Apply 之间文件可能变化。重新核对 fingerprint 可防止覆盖用户并发修改，而不需要永久项目 manifest。

### D-05：不为 project assets 引入隐藏 ownership database

原因：项目文件应可由人直接维护，且已有配置必须保守合并。v0.1 通过 evidence、内容比较、baseline fingerprint 和明确批准维护，避免新增同步状态源。

### D-06：symlink capability fallback，而不是按操作系统硬编码结果

原因：权限、filesystem 和运行环境比 platform name 更能决定 symlink 是否可用。实际尝试并对明确错误 fallback 更可靠。

### D-07：Project Profile 与 Evidence Ledger 默认不持久化

原因：它们是运行时决策数据；持久化会增加陈旧状态、隐私和 reconcile 复杂度。只有最终稳定知识按 persistence scope 写入项目资产。

---

## 22. 明确拒绝的替代方案

- **CLI 自动分析 repository**：违反 “CLI manages files; Agent understands projects”。
- **每次重新生成全部 Agent 文件**：破坏已有配置与幂等性。
- **把 Project Profile 永久保存为第二事实源**：容易过期并污染项目。
- **所有 target 都复制一份 Skill**：制造人工同步问题；copy 只作 fallback。
- **只靠 manifest 路径判断 ownership**：可能删除用户替换的文件。
- **默认安装 Hook 或修改 CI**：改变开发者默认行为，超出 v0.1。
- **技术栈到 Skill 的固定映射表**：缺少项目专项 workflow evidence。
- **大型 repository analyzer/rule engine**：复杂度高且与 Minimal Implementation 冲突。
- **为推荐目录中的每个名字创建 pass-through 文件**：形成 shallow modules，不增加 leverage。

---

## 23. PRD Traceability

| 设计区域 | 覆盖的 PRD 主题 |
|---|---|
| Distribution/Repository 两平面 | 产品架构、CLI 职责、Tool Update 与 Project Reconcile |
| Stable layout + manifest | Stable Installation、Installation Manifest、Claude/Codex targets |
| Ownership 状态模型 | Existing Target Protection、Ownership Protection、Project Assets Survive Uninstall |
| Lifecycle algorithms | Install、Update、Doctor、Uninstall、Version、Idempotency |
| Skill workflow | Phase 0–7、Explore、Project Profile、Proposal、Apply、Validate |
| Classification model | Persistence scope（GLOBAL、WORKFLOW、DISCOVERABLE、ARCHITECTURE、NONE）+ deterministic enforcement flag |
| Generated assets | AGENTS.md、CLAUDE.md、Project Skills、Agent docs、Guardrails |
| Preservation/reconcile | Existing Configuration Preservation、Reconciliation、Unknown Handling |
| Testing/release gates | CLI Testing、Fixtures、Acceptance Criteria、Definition of Done |

本文的实现顺序与可交付检查项见 [TASKS.md](TASKS.md)。
