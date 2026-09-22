# v0.1.3 票据实现 Session 提示词手册

每张票据在独立 session 中通过 `/implement` 实现。使用下面的一套通用流程；依赖以当前票据的 `Blocked by` 为准，索引和批次表用于导航。

## 调用方式与默认授权

**开发位置由本提示词明确指定，不依赖 `/implement` 自动询问或创建 worktree。** 每张票据使用独立 worktree 和专用分支（并行票据尤其如此）；完成验收后，由一个集成 session 在另行授权后逐个合入 `main` 并验证，不由各实现 session 并发更新 `main`。

在仓库目录打开新 session，复制以下完整内容，只替换票据路径：

```text
/implement .scratch/v0.1.3/issues/01-generated-skill-routing.md

读取并遵循 .scratch/v0.1.3/session-prompts.md 的通用实现流程。
本次只实现这一张票据；先核实依赖、当前代码及票据 Comments 中的基线。

本票必须在独立 git worktree 中开发：
依赖验证通过后，从最新且已验证的 origin/main commit 创建本票专用分支和 worktree。
所有编辑、测试和 review 都在该 worktree 内执行，不修改原工作区或其他 session 的工作树。
若本票已有 worktree，按手册核对归属和基线后安全续做，不覆盖或强制复用。

授权本票范围内的本地低风险实现，以及创建上述分支和 worktree。
本次覆盖 /implement 的默认自动提交步骤：实现、验证、review 和交接后停止。
不授权 commit、push、合并、创建 PR 或发布；这些操作等待另外明确授权。
完成后保留 worktree，报告路径、分支和验收结果，等待我授权统一整合到 main。
不自动开始下一张票据。
```

此调用只授权本地实现；CI、关键配置、用户环境等仍遵守适用的确认门禁。以后若明确授权 commit，只提交本票改动；push、集成到 main、发布分别按明确授权执行。遵守当前运行环境的更高优先级规则。

本机 `/implement` 的流程包含 TDD、针对性检查、最终全套测试、`/code-review` 和提交。启动时读取实际安装的 Skill，以当前内容为准；上述调用明确覆盖其自动提交步骤，而非省略验证或 review。Skill 不可用时报告，不声称已调用。

## 通用实现流程

### 1. 固定仓库和依赖基线

- 读取仓库 `AGENTS.md`、`CLAUDE.md`、适用局部规则，以及 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`；使用匹配的可用 Skills。
- 报告 hostname、当前目录、仓库根、分支、remote、`git status` 与 `git diff --stat`。保护已有工作区和暂存区改动，不带入本票提交。
- 更新并核对 `origin/main`，记录其完整 SHA 为 `BASE_SHA`。拉取失败或远端不符时报告并停止；不把过期远端跟踪引用当作最新基线。
- 从该 SHA 读取当前票据全文（含 Comments）、直接前置票据和 PRD 相关章节。PRD 是权威规格，不修改 PRD 或创建竞争规格。规格冲突若影响实现，报告具体冲突并等待澄清。
- Comments 提供已合并能力及剩余缺口线索；逐项对照代码。区分已有、部分实现与未实现，复用已有机制。静态代码、状态标签、其他 session 的声明或聊天中的测试结论都不单独构成验收证据。
- 输出依赖检查表：`前置票据文件序号 / 基线中的实现 / 可定位验收证据 / 是否满足`。核实适用的里程碑门禁和证据适用范围；不要求无关改动使全部历史证据失效，也不复用输入已变化的验收结果。

**完成条件：** 依赖成果已进入 `BASE_SHA`，所需证据有效；没有依赖时明确说明。缺失时列出阻塞并停止，不代做前置票据，不自动合并或 cherry-pick 其他分支。

原工作区未提交的代码、票据或文档不属于 `origin/main` 基线。所需输入尚未整合时报告；不能为绕过依赖检查而复制进 worktree。

### 2. 创建或核对独立 worktree

依赖满足后，从精确的 `BASE_SHA` 创建本票分支和 git worktree。建议名称：`implement/v0.1.3-ticket-<文件序号>`。

- 核对实际基线、PRD 和票据均存在，不假设 worktree 工具自动选对起点。
- 同名分支或 worktree 已存在时，先检查用途、基线及改动。只有确认属于本票且可安全续做时恢复；否则报告等待确认，不覆盖、删除或强制复用。
- 输出 worktree 路径、分支、`BASE_SHA`、`git status` 和 `git diff --stat`。续做时说明已有提交和改动属于本票的证据。
- 后续编辑、测试和 review 均在该 worktree 内执行，不修改原工作树或其他 session 的文件。

**完成条件：** 工作目录、分支与已验证基线对应，且本票的既有改动归属清楚。

### 3. 确定最小实现与 TDD 接缝

先给出简短实施摘要：票据目标、已有能力、剩余缺口、最小文件范围、验收方法及可能冲突的公共文件。

- 为每个行为缺口指定测试接缝：现有公共入口、模块边界或 fixture/evaluator 层，以及可观察的失败。用户已约定的接缝优先；缺乏明确边界且选择会改变架构时先确认。
- 在适用处用 `/tdd`：先建立失败的复现或行为测试，再做最小实现。纯文档或其他不适用场景记录原因及替代验证，不制造无意义测试。
- 使用项目实际存在的检查命令。定期运行相关单文件测试和已有类型/语法检查；没有 typecheck 时标注不适用，不为满足泛化 Skill 指令引入新工具链。
- 仅实现当前票据的交付行为及直接必要改动。复用现有 helpers、fixtures 和约定，保留安全断言和失败案例；不靠跳过测试、弱化预期或伪造 evidence 取得绿色结果。
- 新发现的无关缺陷记录为后续问题；若它阻碍本票安全完成，报告阻塞，不把行为修复藏进机械抽取或扩展到相邻票据。

**完成条件：** 本票实现独立有效，相关测试覆盖真实缺口；不存在依赖另一未整合分支才能工作的半成品。

### 4. 验证与两轴 review

逐项对照 Acceptance criteria，先执行针对性验证，再调用 `/code-review`。提供以下明确输入，避免默认三点 diff 漏掉未提交实现：

- **固定点：** `BASE_SHA`；**Spec：** 当前票据路径、Comments 与 PRD 对应章节；**Standards：** 仓库规则。
- **审查范围：** 本票相对固定点的全部提交、已暂存、未暂存及新增文件。已跟踪文件可用 `git diff BASE_SHA --` 查看最终差异；另列 `git ls-files --others --exclude-standard` 并审阅属于本票的新增文件。
- `<BASE_SHA>...HEAD` 只覆盖提交历史，未提交实现时可能为空，不能作为唯一审查输入。当前 `/code-review` 若不能接收工作区范围，说明限制并做等价 Standards/Spec 两轴审查；不为制造 diff 擅自提交。
- 涉及所有权、路径安全、权限、并发或删除时追加专项审查。记录发现、修复和剩余阻塞；只修本票引入或直接相关的问题。

修复 review 问题后重跑对应测试，最终内容稳定后运行完整测试套件和票据要求的其他验收。全套测试以最终实现为准；发生后续代码修改时补做受影响验证。不得用一次全套绿色替代真实 Harness、跨平台或发布证据。

**完成条件：** 每条验收均有“通过 / 失败 / 未运行 / 受阻”的真实结论和证据；review 的必需修复已处理，未解决项明确披露。

### 5. 发布清单与交接

若改动影响 npm 打包内容（包括 `README.md`）：

1. 先查看 `scripts/release-manifest.js` 的产物/临时路径，确认不会覆盖已有用户文件。
2. 最终内容确定后执行 `node scripts/release-manifest.js`，再执行 `node scripts/release-manifest.js --check`。
3. 将必要的 `release-manifest.json` 变化作为本票派生交付物记录。整合多分支后必须按最终内容重新生成，不能手工合并 tree digest。生成清单不授权 npm 发布。

遵循 tracker 规则，在当前票据的 `## Comments` 追加：实现摘要、基线 SHA、依赖结论、验证命令及真实结果、可定位证据、review 结果、未完成项和人工步骤。不记录凭证或隐私，不创建无关文档。只勾选已实际验证的验收项，保留其他票据不变，Status 仅使用仓库定义值。

最后运行 `git diff --check` 并核对 Git 状态，报告：

- worktree、分支、基线和修改文件；
- 验收通过、失败、未运行和受阻项；
- review 结论与共享文件冲突风险；
- 代码实现、全部验收、集成就绪三个层次各自的状态；
- 后续整合或人工操作所需条件。

**完成条件：** 交付物与当前票据一致，证据可追溯，未验证事项未被写成完成。默认保留未提交改动与 worktree 后停止。

## 隔离、权限与真实验收

- 测试、故障注入和删除验证使用隔离临时 HOME/仓库。真实用户资产、凭证、用户环境和远端操作继续遵守审批门禁；不得让 subagent 绕过权限限制。
- CI/关键配置修改先说明范围、影响、回滚方式并取得所需批准。普通实现授权不自动包含这些动作。
- 需要真实 Harness、账号或人工步骤但不可用时报告阻塞；mock 只用于程序测试，不冒充真实验收。
- **06–09、13：** installer registry 的六 Harness 安装支持及静态 `verification` 标签，不是 Claude/Codex 当前输入的 live routing 证据。09 的 gate 程序通过单元测试，不等于两端真实阈值已通过。
- **14–20：** 用户级 manifest-owned target 的 uninstall/reconcile 与项目级 Proposal/RETIRE 是两个范围，不能互相替代验收。
- **23、25：** `release-manifest.json` 是分发产物证据，不是完整 `release-qualification.json`。25 必须区分发布前门禁、单独授权发布、发布后 registry 验证；全部必要证据通过后才能声明 100% Qualified。
- **24：** 新增 characterization 测试是抽取前的基础，不证明历史两目标行为等价，也不证明机械抽取已完成。行为缺陷独立报告。

## 25 张票据索引

前置序号对应文件名 `01～25`，票据正文使用 AI 编号。以下是导航快照；与当前票据 `Blocked by` 或 PRD 里程碑要求不一致时，先核实并报告差异，不按过时表格开工。

| 文件序号 | 前置序号 | 票据路径 |
|---|---|---|
| **01** | 无 | `.scratch/v0.1.3/issues/01-generated-skill-routing.md` |
| **02** | 无 | `.scratch/v0.1.3/issues/02-operation-parent-rollback.md` |
| **03** | 无 | `.scratch/v0.1.3/issues/03-release-version-ssot.md` |
| **04** | 无 | `.scratch/v0.1.3/issues/04-ci-action-pinning.md` |
| **05** | 无 | `.scratch/v0.1.3/issues/05-product-document-status.md` |
| **06** | 01、02、03、04、05 | `.scratch/v0.1.3/issues/06-trigger-corpus-artifact.md` |
| **07** | 06 | `.scratch/v0.1.3/issues/07-claude-live-acceptance.md` |
| **08** | 06 | `.scratch/v0.1.3/issues/08-codex-live-acceptance.md` |
| **09** | 07、08 | `.scratch/v0.1.3/issues/09-trigger-threshold-gate.md` |
| **10** | 09 | `.scratch/v0.1.3/issues/10-evaluator-mutation-matrix.md` |
| **11** | 09 | `.scratch/v0.1.3/issues/11-workflow-transition-fixtures.md` |
| **12** | 09 | `.scratch/v0.1.3/issues/12-ambiguous-evidence-fixtures.md` |
| **13** | 09 | `.scratch/v0.1.3/issues/13-acceptance-freshness.md` |
| **14** | 10、11、12、13 | `.scratch/v0.1.3/issues/14-unreferenced-document-retirement.md` |
| **15** | 14 | `.scratch/v0.1.3/issues/15-skill-bundle-retirement.md` |
| **16** | 15 | `.scratch/v0.1.3/issues/16-coordinated-reference-retirement.md` |
| **17** | 16 | `.scratch/v0.1.3/issues/17-workflow-rename.md` |
| **18** | 16 | `.scratch/v0.1.3/issues/18-workflow-split.md` |
| **19** | 16 | `.scratch/v0.1.3/issues/19-workflow-merge.md` |
| **20** | 17、18、19 | `.scratch/v0.1.3/issues/20-pruning-idempotency.md` |
| **21** | 20 | `.scratch/v0.1.3/issues/21-context-architecture.md` |
| **22** | 21 | `.scratch/v0.1.3/issues/22-context-duplication.md` |
| **23** | 22 | `.scratch/v0.1.3/issues/23-qualification-traceability.md` |
| **24** | 23 | `.scratch/v0.1.3/issues/24-lifecycle-pure-extraction.md` |
| **25** | 23、24 | `.scratch/v0.1.3/issues/25-final-release-gate.md` |

## 调度与集成

批次表示依赖上的候选集合，不承诺共享状态独立。只有明确列出互不依赖的子任务，且写入范围独立或共享接口已固定，才并行实施；共享语义或核心文件冲突明显时串行。worktree 隔离文件，不解决协议分歧。

| 批次 | 文件序号 | 调度提醒 |
|---|---|---|
| 1 | 01、02、03、04、05 | 核对共享文件；03/04 可能同时修改 release workflow |
| 2 | 06 | 建立后续 runner 共用契约 |
| 3 | 07、08 | 共享契约固定后可独立执行；分别保留真实证据 |
| 4 | 09 | 两端真实阈值证据是门禁的一部分 |
| 5 | 10、11、12、13 | 核对 evaluator、fixture 和 artifact 接口冲突 |
| 6 | 14 | 单独执行 |
| 7 | 15 | 单独执行 |
| 8 | 16 | 单独执行 |
| 9 | 17、18、19 | 共享 reconciliation/RETIRE 语义；接口未固定时串行 |
| 10 | 20 | 单独执行 |
| 11 | 21 | 单独执行 |
| 12 | 22 | 单独执行 |
| 13 | 23 | 单独执行 |
| 14 | 24 | 单独执行，保留抽取前后证据 |
| 15 | 25 | 发布需独立授权，registry 验证后才可完成资格判定 |

集成由一个 session 在明确授权后串行处理，目标是 `main`。每次按当前 main 复核差异、解决冲突、重新生成受影响的发布摘要并验证组合结果；不能以各分支单独通过代替整合验收。推送后确认远端提交，后续票据再从新的 `origin/main` 验证依赖。具体提交/分支操作服从当前工具规则，不让多个实现 session 并发更新 main。
