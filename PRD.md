# PRD — Agent Init v0.1.3

**项目：** Agent Init  
**版本：** v0.1.3  
**状态：** Ready for Implementation  
**基线：** v0.1.2 / `main`  
**目标 Harness：** Claude Code / Codex CLI  
**目标：** 在不改变现有核心架构的前提下，将当前已知能力补齐为可验证的 100% Qualified 状态。

---

# 1. 背景

Agent Init v0.1.2 已完成核心产品架构：

```text
Lightweight Node CLI
        ↓
Canonical project-setup Mother Skill
        ↓
Claude Code / Codex
        ↓
Repository Analysis
        ↓
Minimal AGENTS.md
CLAUDE.md Adapter
Project-specific Skills
Agent Documentation
```

当前系统已经具备：

- 安装、升级、Doctor、卸载；
- canonical mother Skill；
- Claude / Codex 双端共享；
- ownership-safe filesystem lifecycle；
- crash recovery；
- exact Proposal + Approval；
- Evidence Ledger；
- Knowledge Classification；
- Project Skill candidate detection；
- project Skill generation；
- progressive disclosure；
- fixture matrix；
- local evaluator；
- CI / package / release verification。

当前源码审查后的完成度：

```text
基础设施层      96%
安装/升级       97%
安全模型        98%
SSOT            96%
Context 架构    98%

Skill 判定      92%
Trigger 可靠性  80%
Eval            94%
Pruning         68%
```

v0.1.3 的目标不是继续增加新的 Agent 功能，而是：

> **关闭所有当前已知缺口，并建立足够强的自动化与真实 Harness 验收，使当前定义范围内所有核心指标达到 100% Qualified。**

---

# 2. 产品目标

v0.1.3 必须完成四件核心事情。

## 2.1 Close Known Correctness Gaps

关闭当前已经确认的实现缺口：

- generated Skill routing metadata 缺少完整 evaluator contract；
- operation-created discovery parent rollback 不完整；
- release version 存在重复来源；
- CI Action pinning 不一致；
- PRD / DESIGN / TASKS 状态与实际发布状态漂移。

## 2.2 Prove Real Skill Routing

必须把以下两个问题完全分开验证：

```text
Should this Skill exist?
```

和：

```text
Will Claude Code / Codex actually load this Skill?
```

v0.1.3 必须建立真实 Harness acceptance：

```text
Generated Skill
        ↓
fresh Claude / Codex session
        ↓
real user prompt
        ↓
Skill selection
        ↓
recorded acceptance evidence
```

不能继续只依赖：

- frontmatter regex；
- fixture oracle；
- local evaluator；
- 人工判断 description “看起来应该能触发”。

## 2.3 Add Safe Knowledge Retirement

当前 reconcile 已支持：

```text
CREATE
UPDATE
KEEP
SKIP
RECOMMEND
```

但缺少完整的 obsolete knowledge lifecycle。

v0.1.3 必须增加：

```text
RETIRE
```

用于安全移除：

- obsolete project Skills；
- obsolete Agent docs；
- stale Agent-only references。

RETIRE 必须：

- evidence-backed；
- explicit Proposal；
- explicit Approval；
- fingerprint-bound；
- reference-safe；
- fail closed。

## 2.4 Establish 100% Qualification Gate

“100%”不能由 README 或人工声称。

必须形成：

```text
Code
+
Tests
+
Fixtures
+
Local Evaluator
+
Cross-platform CI
+
Real Claude Acceptance
+
Real Codex Acceptance
+
Release Qualification
```

所有关键结论都必须有可验证 evidence。

---

# 3. 100% 的定义

本项目中的 `100%` 定义为：

> 当前 PRD 所定义范围内，所有已知能力缺口均已关闭；关键 deterministic 行为均有自动化回归；Agent 非确定性行为均有真实 Harness acceptance；所有 Acceptance Criteria 均可以追溯到测试或验收证据。

100% 不表示：

```text
永远不会出现新 bug
模型路由概率恒等于 100%
所有未来 Claude/Codex 版本永久兼容
支持世界上所有 repository
```

---

# 4. 非目标

v0.1.3 不新增以下能力：

```text
AST repository analyzer
dependency graph engine
vector database
custom repository index
generic rule engine
numerical Skill scoring engine
AI plugin framework
automatic CI editing
automatic Hook installation
automatic permission mutation
automatic production code refactoring
automatic architecture refactoring
business source modification
database migration execution
Git commit / push / PR automation
```

不得为了达到 100% 而扩大产品职责。

---

# 5. 核心设计原则

v0.1.3 继续遵循现有原则。

## 5.1 Minimal Change

优先级：

```text
existing project capability
        ↓
Node standard library
        ↓
existing helper/evaluator
        ↓
small new implementation
```

禁止为了新验收能力进行大规模重构。

## 5.2 Evidence First

任何：

```text
CREATE
UPDATE
RETIRE
```

都必须由当前 repository evidence 支撑。

禁止：

```text
missing evidence
→ assume obsolete
→ delete
```

## 5.3 Context Pointer > Context Dump

继续保持：

```text
AGENTS.md
    ↓
minimal global rules

Skills
    ↓
task-specific workflows

docs/agents
    ↓
deep durable knowledge

Source
    ↓
discoverable implementation detail
```

## 5.4 Agent Understands, Program Verifies

保持：

```text
Agent
→ understand intent
→ classify knowledge
→ decide candidate

Program
→ collect deterministic facts
→ validate scope
→ validate evidence
→ validate approval
→ validate filesystem
→ validate acceptance artifact
```

不得把 project understanding 重写成大型 deterministic rule engine。

---

# 6. Milestone 6 — Known Gap Closure

目标：

```text
基础设施      98%
安装/升级     100%
安全模型      99%
SSOT          99%
Context       99%
Skill 判定    95%
Eval          96%
```

---

# 7. Generated Skill Routing Contract

## 7.1 问题

当前 generated project Skill 已要求：

```text
When to use
When not to use
Workflow
Project-specific rules
Verification
```

但 evaluator 对 routing metadata 的约束不足。

Skill 的真正 routing surface 是：

```yaml
---
name: ...
description: ...
---
```

v0.1.3 必须将 routing metadata 提升为正式 contract。

## 7.2 Skill Decision Model

每个 CREATE / UPDATE Skill candidate 必须包含：

```yaml
name:

routing:
  description:
  positiveIntents:
  negativeIntents:

taskTriggers:
whenNotToUse:
workflowSteps:
verification:
```

其中：

### `description`

必须描述：

```text
What the Skill does
+
When the Skill should apply
```

不得只写技术栈：

```text
Java backend conventions.
```

### `positiveIntents`

描述典型应触发任务，例如：

```text
adding a Flyway migration
changing an audit-logged write endpoint
running the repository-specific release workflow
```

### `negativeIntents`

描述容易误触发但不应加载的相近任务。

例如：

```text
explaining Flyway conceptually
reading an entity mapping
ordinary Redis code changes
```

## 7.3 Generated Skill Contract

canonical project Skill 必须至少满足：

```yaml
---
name: <directory-name>
description: <approved routing description>
---
```

并包含：

```text
## When to use
## When not to use
## Workflow
## Project-specific rules
## Verification
```

## 7.4 Acceptance Criteria

### AC-R01

缺少 `description` 的 generated Skill 必须 evaluator FAIL。

### AC-R02

空 `description` 必须 FAIL。

### AC-R03

`name` 必须与 Skill directory 完全一致。

### AC-R04

最终 Skill bytes 必须与 approved Proposal payload 一致。

### AC-R05

未经 Approval 修改 description 必须 FAIL。

---

# 8. Transaction-Owned Parent Rollback

## 8.1 问题

安装过程中可能创建：

```text
~/.agents/
~/.agents/skills/
~/.claude/
~/.claude/skills/
```

这些目录不属于永久 installer ownership。

如果 fresh install 在后续步骤失败：

> 本次 operation 自己创建、仍为空、身份未发生变化的 parent 必须被 rollback。

## 8.2 Required Behavior

创建 parent 时必须记录：

```text
path
operationId
entry identity
```

Rollback 前重新验证：

```text
same path
same entry identity
directory
empty
created by current operation
```

全部成立：

```text
rmdir
```

任何条件不成立：

```text
preserve
report
```

## 8.3 Forbidden Behavior

永远不得：

```text
recursive rm parent
delete pre-existing parent
delete parent containing foreign content
delete parent whose identity changed
delete parent during normal uninstall
```

## 8.4 Acceptance Criteria

### AC-PAR01

fresh HOME 安装失败后，本次创建且仍为空的 parent 被清理。

### AC-PAR02

parent 内出现 foreign file 后必须保留。

### AC-PAR03

parent identity 被替换后必须保留。

### AC-PAR04

pre-existing parent 永远保留。

### AC-PAR05

正常 uninstall 永不删除 `.agents` / `.claude` discovery parents。

---

# 9. Release Version SSOT

唯一 release version source 必须为：

```text
package.json
```

以下内容不得独立硬编码版本：

```text
workflow name
expected version
tarball filename
registry version
artifact path
release verification
```

Release workflow 必须动态读取：

```text
package name
package version
npm pack filename
```

## Acceptance Criteria

### AC-S01

修改 `package.json` version 后无需修改 release workflow 中任何版本常量。

### AC-S02

CLI、package、tarball、registry verification 使用同一 version source。

---

# 10. CI Supply-Chain Consistency

所有 GitHub Actions dependency 必须采用 immutable commit SHA pinning：

```yaml
uses: actions/checkout@<sha> # vX
uses: actions/setup-node@<sha> # vX
```

CI 与 release workflow 使用相同安全策略。

---

# 11. Product Documentation State

v0.1.3 必须修正文档状态漂移。

建议：

```text
PRD.md
Status: Released Baseline

DESIGN.md
Status: Implemented / Maintained

TASKS.md
Status: Historical v0.1 Roadmap
```

AI-001 ~ AI-034 保留为历史实现路线。

v0.1.3 新任务从：

```text
AI-035
```

继续。

---

# 12. Milestone 7 — Real Trigger Qualification

目标：

```text
Skill 判定      ≥98%
Trigger         100% Qualified
Eval            ≥98%
```

---

# 13. Trigger Evaluation Corpus

每个需真实验收的 generated Skill 必须提供四种 prompt。

## 13.1 Positive

明确应该加载 Skill。

例如：

```text
Add a Flyway migration for the new customer_status column.
```

## 13.2 Negative

明确不应加载。

例如：

```text
Explain what Flyway does in this project.
```

## 13.3 Near Miss

词汇相近，但任务不属于 workflow。

例如：

```text
Tell me which database column this entity field maps to.
```

## 13.4 Collision

一个任务可能同时涉及多个 Skill。

例如：

```text
Add the migration and update audit logging for this new field.
```

---

# 14. Trigger Corpus Schema

建议：

```json
{
  "schemaVersion": 1,
  "id": "database-migration-positive-01",
  "fixture": "12-flyway-database-migration",
  "prompt": "...",
  "expected": {
    "mustLoad": [
      "database-migration"
    ],
    "mustNotLoad": [
      "build-verify"
    ]
  }
}
```

Corpus 必须进入 repository 并接受版本控制。

---

# 15. External Acceptance Artifact

真实 Claude / Codex 验收结果必须形成结构化 artifact。

最低字段：

```json
{
  "schemaVersion": 1,

  "harness": "claude-code",
  "harnessVersion": "...",

  "fixtureId": "...",
  "caseId": "...",

  "motherSkillDigest": "sha256:...",
  "generatedSkillDigest": "sha256:...",
  "triggerCorpusDigest": "sha256:...",

  "expected": {
    "mustLoad": [],
    "mustNotLoad": []
  },

  "observed": {
    "loaded": []
  },

  "result": "pass",

  "recordedAt": "..."
}
```

---

# 16. Claude Code Live Acceptance

必须提供真实 Claude Code acceptance runner。

流程：

```text
Disposable HOME
        ↓
Install current package
        ↓
Prepare fixture repository
        ↓
Fresh Claude Code session
        ↓
Run /project-setup
        ↓
Apply approved fixture Proposal
        ↓
Close session
        ↓
Fresh Claude Code session
        ↓
Run Trigger Corpus prompt
        ↓
Record actual Skill selection
        ↓
Write acceptance artifact
```

必须使用 fresh session，避免先前 context 污染路由结果。

---

# 17. Codex Live Acceptance

Codex 使用同一协议：

```text
Disposable environment
        ↓
install
        ↓
fixture repository
        ↓
fresh Codex session
        ↓
$project-setup
        ↓
generated project Skills
        ↓
fresh session
        ↓
Trigger Corpus
        ↓
record selection
```

Claude / Codex 可以共享：

```text
fixture preparation
artifact schema
digest logic
result evaluator
```

但不得引入通用 Agent framework。

---

# 18. Trigger Qualification Threshold

Trigger 的 `100% Qualified` 不等于语言模型随机性为零。

Release qualification 定义为：

```text
Explicit invocation:
100%

Positive implicit routing:
>= 95%

Negative false activation:
<= 2%

Collision / multi-Skill routing:
>= 90%
```

上述 threshold 必须在当前 release payload 上全部通过。

---

# 19. Stale Acceptance Detection

External acceptance 必须绑定：

```text
mother Skill digest
generated Skill digest
fixture digest
trigger corpus digest
```

任意一项变化：

```text
acceptance status = stale
```

Release Gate 必须要求重新执行。

历史 acceptance 不得证明当前 payload。

---

# 20. Milestone 8 — Evaluation Completion

目标：

```text
Skill 判定    100% Qualified
Eval          100% Qualified
```

---

# 21. Evaluator Mutation Matrix

每一个 evaluator invariant 必须具备：

```text
known-good artifact
+
single intentional mutation
+
expected evaluator failure
```

例如：

```text
Approval digest modified
→ APPROVAL_PAYLOAD

write before approval
→ APPROVAL_GATE

Skill description removed
→ PROJECT_SKILL_METADATA

verification unsupported by evidence
→ EVIDENCE

final bytes differ
→ PAYLOAD_MISMATCH

CLAUDE duplicates AGENTS rule
→ DUPLICATED_RULES
```

---

# 22. Behavioral Fixture Expansion

新增 fixture 不按语言数量扩展。

禁止优先新增：

```text
Go
Rust
Kotlin
.NET
```

除非出现新的行为边界。

优先新增：

```text
16-workflow-renamed
17-workflow-removed
18-workflow-split
19-workflow-merged
20-user-edited-generated-skill
21-conflicting-agent-instructions
22-stale-architecture-doc
23-overlapping-skills
24-partially-evidenced-workflow
```

测试的是：

```text
decision difficulty
```

而不是：

```text
technology coverage
```

---

# 23. Milestone 9 — Safe Pruning

目标：

```text
Pruning   100% Qualified
SSOT      100%
Safety    100%
```

---

# 24. Introduce RETIRE

Proposal Action 扩展为：

```text
CREATE
UPDATE
KEEP
SKIP
RECOMMEND
RETIRE
```

Mutation actions：

```text
CREATE
UPDATE
RETIRE
```

Non-write：

```text
KEEP
SKIP
RECOMMEND
```

---

# 25. RETIRE Semantics

RETIRE 表示：

> 当前 repository evidence 明确证明某份持久化 Agent knowledge 已不再适用于项目，并且安全删除该资产比继续保留更正确。

---

# 26. Missing Evidence Is Not Retirement Evidence

必须始终满足：

```text
missing evidence
≠
obsolete
```

如果过去的 workflow 当前无法重新确认：

```text
KEEP
+
warning
```

不得：

```text
RETIRE
```

---

# 27. RETIRE Positive Evidence

RETIRE 必须有积极证据。

例如旧 Skill：

```text
deployment
→ scripts/deploy.sh
```

现在 repository 明确表现为：

```text
deploy.sh removed
+
CI changed to new deployment mechanism
+
documentation identifies replacement workflow
+
old Skill conflicts with current workflow
```

才可以：

```text
RETIRE deployment
```

---

# 28. Agent-Plane Reference Scan

RETIRE 前必须扫描限定范围：

```text
AGENTS.md
CLAUDE.md
.agents/
.claude/
docs/agents/
```

不建立 repository-wide dependency graph。

如果 retiring target 仍被引用：

```text
RETIRE alone → invalid
```

Proposal 必须同时包含：

```text
UPDATE references
+
RETIRE obsolete asset
```

---

# 29. RETIRE Proposal

必须展示：

```text
target
reason
evidenceIds
current fingerprint/tree digest
reference impact
replacement, if any
```

用户必须明确批准 RETIRE。

---

# 30. RETIRE Apply

Apply 时必须重新验证：

```text
normalized repository-relative target
physical containment
no symlink escape
entry identity
tree digest / fingerprint
approved Proposal revision
approved RETIRE action ID
```

Proposal 后 target 发生任何变化：

```text
RETIRE STOP
```

要求重新生成 Proposal。

---

# 31. Workflow Identity Reconciliation

v0.1.3 必须区分：

```text
rename
split
merge
remove
```

## 31.1 Rename

同一 workflow 只是命名改变：

```text
build-check
→
build-verify
```

不得机械：

```text
CREATE build-verify
RETIRE build-check
```

应识别 semantic continuity，并生成最小迁移 Proposal。

## 31.2 Split

```text
release
→
release-verify
release-publish
```

旧 Skill 的 retirement 必须和两个新 workflow 的建立放在同一个 Proposal 中。

## 31.3 Merge

```text
lint
test
→
build-verify
```

不能留下 orphan Skills。

## 31.4 Removed

真正没有 replacement 的 workflow：

```text
RETIRE
```

---

# 32. Pruning Idempotency

完成一次 reconcile：

```text
RETIRE obsolete Skill
UPDATE references
```

后再次执行 project-setup：

```text
CREATE = 0
UPDATE = 0
RETIRE = 0
writes = 0
```

才视为 pruning 完成。

---

# 33. Milestone 10 — 100% Qualification

目标：

```text
基础设施      100%
安装/升级     100%
安全模型      100%
SSOT          100%
Context 架构  100%
Skill 判定    100%
Trigger       100% Qualified
Eval          100% Qualified
Pruning       100% Qualified
```

---

# 34. Context Architecture Contract

正式验证：

## AGENTS.md

只能承担：

```text
GLOBAL
+
high-value pointers
```

不得持久化大量 DISCOVERABLE 信息。

## CLAUDE.md

共享规则不得复制。

默认：

```markdown
@AGENTS.md
```

Claude-specific 内容必须有 Claude-specific evidence。

## Project Skills

必须：

```text
WORKFLOW scoped
task specific
evidence backed
routing metadata complete
observable verification
```

## docs/agents

用于：

```text
durable deep architecture
complex reference knowledge
```

不得成为另一个全局 Prompt dump。

---

# 35. Context Duplication Validation

Evaluator 必须检查：

```text
AGENTS ↔ CLAUDE duplicate
AGENTS ↔ Skill unnecessary duplication
Skill ↔ docs wholesale duplication
duplicate canonical Skills
duplicate Claude Skill copies/references
```

禁止通过简单字数限制代替语义边界。

---

# 36. Release Qualification Artifact

必须生成机器可读：

```text
release-qualification.json
```

示例：

```json
{
  "schemaVersion": 1,

  "distribution": "pass",
  "installation": "pass",
  "security": "pass",
  "ssot": "pass",
  "contextArchitecture": "pass",
  "skillDecision": "pass",
  "trigger": "pass",
  "evaluation": "pass",
  "pruning": "pass"
}
```

每一个 pass 必须引用实际 evidence。

不得只有：

```json
"pass": true
```

---

# 37. Acceptance Traceability

所有 PRD Acceptance Criteria 必须能追踪至：

```text
unit / integration test
fixture oracle
filesystem evaluator
CI job
external Claude acceptance
external Codex acceptance
release artifact verification
```

任何无 evidence 的 Acceptance Criteria：

```text
not qualified
```

---

# 38. Lifecycle Maintainability

`src/installation/lifecycle.js` 的拆分属于最后阶段。

要求：

```text
existing characterization tests first
↓
pure extraction
↓
no behavior change
↓
same public executeLifecycle interface
```

允许形成：

```text
lifecycle/
  install-flow.js
  update-flow.js
  uninstall-flow.js
  recovery-flow.js
```

仅当这些模块拥有独立 invariant。

禁止：

```text
为缩短文件而拆
大量一层 wrapper
过度 abstraction
generic lifecycle framework
```

---

# 39. Release Gate

正式 publish 前必须同时满足：

```text
npm test PASS

Ubuntu PASS
macOS PASS
Windows Native PASS

npm pack lifecycle PASS

installation crash/recovery PASS

ownership/race/no-follow PASS

project fixture matrix PASS

mutation matrix PASS

context architecture contract PASS

pruning lifecycle PASS

Claude external acceptance CURRENT + PASS

Codex external acceptance CURRENT + PASS

trigger thresholds PASS

acceptance traceability COMPLETE

release artifact digest PASS

registry artifact digest PASS
```

任何：

```text
missing
stale
fail
```

都不得标记：

```text
100% Qualified
```

---

# 40. Implementation Milestones

## Milestone 6 — Known Gap Closure

```text
AI-035 Generated Skill Routing Metadata
AI-036 Operation-Created Parent Rollback
AI-037 Release Version SSOT
AI-038 CI Supply-Chain Pinning
AI-039 Product Document Status Reconciliation
```

## Milestone 7 — Real Trigger Qualification

```text
AI-040 Trigger Evaluation Corpus
AI-041 External Acceptance Artifact
AI-042 Claude Code Live Acceptance
AI-043 Codex Live Acceptance
AI-044 Trigger Release Gate
```

## Milestone 8 — Evaluation Completion

```text
AI-045 Evaluator Mutation Matrix
AI-046 Behavioral Fixture Expansion
AI-047 Payload-Bound Acceptance Freshness
```

## Milestone 9 — Safe Pruning

```text
AI-048 RETIRE Decision
AI-049 Agent-Plane Reference Safety
AI-050 RETIRE Apply Protocol
AI-051 Workflow Identity Reconciliation
AI-052 Pruning Idempotency
```

## Milestone 10 — Qualification

```text
AI-053 Context Architecture Contract
AI-054 Release Qualification Artifact
AI-055 Acceptance Traceability
AI-056 Lifecycle Maintainability Refactor
AI-057 100% Release Gate
```

---

# 41. Implementation Order

必须按以下顺序推进：

```text
AI-035 → AI-039
        ↓
AI-040 → AI-044
        ↓
AI-045 → AI-047
        ↓
AI-048 → AI-052
        ↓
AI-053 → AI-057
```

不得优先实现：

```text
RETIRE
```

而跳过 Trigger Qualification。

原因：

> 当前最大的产品不确定性不是“怎么删 Skill”，而是“生成出来的 Skill 是否真的被 Harness 正确加载”。

---

# 42. Quality Priorities

优先级：

```text
1. 不破坏用户资产
2. 不删除证据不足的 Agent knowledge
3. 不生成错误项目事实
4. Skill 路由准确
5. Context 保持最小
6. Claude / Codex 保持 SSOT
7. Reconcile 可安全演进
8. Evaluation 可以发现反例
9. Release evidence 不过期
10. 代码保持可维护
```

---

# 43. Definition of Done

v0.1.3 只有在以下完整流程成立时才算完成：

```text
npm package built
        ↓
install succeeds
        ↓
Claude discovers mother Skill
Codex discovers mother Skill
        ↓
project-setup analyzes repository
        ↓
Skill candidates are correctly CREATE / KEEP / SKIP
        ↓
generated Skill has valid routing metadata
        ↓
fresh Claude session routes correctly
        ↓
fresh Codex session routes correctly
        ↓
positive / negative / near-miss / collision corpus passes
        ↓
project changes
        ↓
reconcile detects changed workflows
        ↓
obsolete Agent knowledge can be safely RETIREd
        ↓
references remain valid
        ↓
second reconcile produces zero writes
        ↓
all evaluator mutation tests pass
        ↓
all platforms pass
        ↓
external acceptance is current for exact payload
        ↓
release qualification artifact complete
        ↓
registry artifact verified
```

---

# 44. 最终目标

v0.1.3 完成后，Agent Init 不只是：

```text
生成 AGENTS.md 和 Skills 的工具
```

而应该成为：

```text
Repository Evidence
        ↓
Knowledge Classification
        ↓
Correct Persistence Layer
        ↓
Minimal Global Context
        ↓
Scoped Skills
        ↓
Reliable Skill Routing
        ↓
Safe Reconciliation
        ↓
Safe Retirement
        ↓
Observable Validation
```

最终原则保持不变：

> **Persist only what materially improves future Agent behavior.**

> **Load knowledge only when the task needs it.**

> **Unknown remains Unknown.**

> **Missing evidence is not deletion evidence.**

> **Every mutation requires evidence, exact scope, explicit approval, and verification.**

> **Every release claim must be backed by current executable evidence.**
