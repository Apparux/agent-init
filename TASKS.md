# TASKS — Agent Init v0.1

**依据：** [PRD.md](PRD.md) 与 [DESIGN.md](DESIGN.md)  
**状态：** Not Started  
**范围：** 实现与验证路线图；本文本身不包含代码实现

---

## 1. 使用说明

- 任务编号用于稳定引用，整体按里程碑组织；执行顺序以每项 `Blocked by` 为准，只有依赖全部完成后才开始该任务。少数跨平面的验收任务会依赖后编号任务。
- 每个行为任务遵循 TDD：先写失败测试，再写最小实现，最后重构并运行相关回归测试。
- 本文件是 v0.1 release roadmap。Milestones 可以在依赖允许时交错推进；跨平面 acceptance 可能依赖后编号任务。
- 标记为 optional/evaluate-first 的任务，在 PRD 允许时可用 evidence-backed `DEFER` 作为完成结果，但必须保留相应 safety/negative acceptance test。
- 若实施时发布到本地 issue tracker，必须按 `docs/agents/issue-tracker.md` 将每个任务拆成 `.scratch/<feature>/issues/<NN>-<slug>.md`，不要用本文件替代 issue 状态与评论历史。
- 不为匹配目录结构而创建没有独立职责的文件；实际文件拆分以 [DESIGN.md](DESIGN.md) 中的 Module、Interface 与 Seam 为准。
- `publish`、远端 CI 修改以及任何影响用户环境的真实安装验证，都需要在执行时单独获得授权。

### 1.1 每个任务的完成标准

任务只有同时满足以下条件才可标记完成：

- [ ] 任务范围内的测试先失败、后通过；
- [ ] 实现满足对应 PRD acceptance criteria 与 DESIGN safety invariants；
- [ ] 错误路径带路径、原因和 remediation，不静默吞异常；
- [ ] 测试未访问开发者真实 `~/.agents`、`~/.claude` 或 `~/.agent-init`；
- [ ] 每个 lifecycle test 都验证 temporary HOME 中预置的 foreign sentinel 在 success/failure/conflict/race/crash/retry 后保持 content、entry type、link text 与 relevant mode bits 不变；
- [ ] 没有不相关的文件或依赖变更；
- [ ] 相关测试与回归测试通过；
- [ ] 可见输出、文件状态与原始需求一致；
- [ ] 若任务在 Git repository 中实施，将最终状态与 preflight baseline 比较：只有 approved paths 可出现新增 delta，pre-existing dirty entries 必须保持内容与 staged/unstaged/untracked 状态不变。

---

## 2. 依赖总览

| ID | 任务 | Blocked by | 主要 PRD 验收 |
|---|---|---|---|
| AI-001 | 初始化 package 与最小 CLI test seam | — | AC-D01, AC-D07 |
| AI-002 | 建立隔离测试工具与 temporary HOME | AI-001 | CLI Testing safety |
| AI-003 | 实现 runtime paths 与 metadata version | AI-001, AI-002 | AC-D02, AC-D03 |
| AI-004 | 实现 manifest schema 与 deterministic digest | AI-002, AI-003 | ownership foundation |
| AI-005 | 实现 managed filesystem transaction | AI-002, AI-003 | safe install/update |
| AI-006 | 实现 target inspection 与 ownership state | AI-004, AI-005 | AC-D11, AC-D12, AC-D13 |
| AI-007 | 建立 lifecycle planning Interface | AI-004, AI-005, AI-006 | lifecycle consistency |
| AI-008 | 完成 CLI parsing、output 与 error contract | AI-003, AI-007 | AC-D07 |
| AI-009 | 实现 install 与 repair | AI-007, AI-008 | AC-D01–AC-D06, AC-D08, AC-D11 |
| AI-010 | 实现 read-only doctor | AI-006, AI-008, AI-009 | AC-D13 |
| AI-011 | 实现 ownership-safe uninstall | AI-007, AI-008, AI-009 | AC-D10, AC-D11 |
| AI-012 | 完成 symlink fallback 与平台差异 | AI-009, AI-010, AI-011 | AC-D12 |
| AI-013 | 验证 npm tarball distribution lifecycle | AI-009–AI-012, AI-014 | AC-D01–AC-D03, AC-D06–AC-D13（update 除外） |
| AI-014 | 建立可发现的 mother Skill skeleton | AI-001 | Project Setup packaging foundation |
| AI-015 | 建立 project fixture/evaluation harness | AI-002, AI-014 | Project Setup Testing Focus |
| AI-016 | 实现 optional deterministic fact collector | AI-014, AI-015 | Explore optimization |
| AI-017 | 定义并验证 Preflight 与 Explore | AI-015 | Phase 0–1 |
| AI-018 | 定义 Project Profile 与 Evidence Ledger | AI-017 | Phase 2, AC-P13 |
| AI-019 | 实现 knowledge classification behavior | AI-018 | AC-P03–AC-P05, AC-P09 |
| AI-020 | 实现 Proposal 与 approval gate | AI-018, AI-019 | Proposal/Apply safety |
| AI-021 | 实现 minimal AGENTS/CLAUDE generation | AI-019, AI-020 | AC-P04–AC-P07, AC-P10–AC-P11 |
| AI-022 | 实现 scoped Apply 与 Validate | AI-020, AI-021 | AC-P10–AC-P16 |
| AI-023 | 实现 Skill candidate detection | AI-019, AI-020 | AC-P03, AC-P08–AC-P09 |
| AI-024 | 实现 project Skill generation 与跨 Agent 共享 | AI-022, AI-023 | AC-P08, AC-P12 |
| AI-025 | 实现 CLI update 与 rollback | AI-007–AI-013 | AC-D07, AC-D09 |
| AI-026 | 验证 existing configuration preservation | AI-022, AI-024 | AC-P10–AC-P12 |
| AI-027 | 实现 reconcile 与 idempotency | AI-022, AI-024, AI-026 | AC-P18 |
| AI-028 | 完成 core repository fixture matrix | AI-027 | AC-P01–AC-P16, AC-P18 |
| AI-029 | 实现 deterministic guardrail recommendations | AI-020, AI-028 | AC-P15–AC-P16 |
| AI-030 | 评估 architecture guidance 并验证限制 | AI-020, AI-028 | AC-P17 |
| AI-031 | 完成 package docs 与 files 清单 | AI-025, AI-028, AI-029 | distribution readiness |
| AI-032 | 建立跨平台自动化与 smoke validation | AI-025 | platform support |
| AI-033 | 执行 v0.1 acceptance 与 release dry run | AI-025, AI-028–AI-032 | AC-D01–13, AC-P01–18 |
| AI-034 | 完成发布前决策、发布 v0.1 并验证 registry 安装 | AI-033 | Definition of Done |

---

# Milestone 1 — Distribution Foundation

## AI-001 — 初始化 package 与最小 CLI test seam

**Blocked by:** —

**目标**

建立 Node.js 18+、ESM、无 build step 的最小 npm package，使后续行为能通过 CLI Runner Interface 测试。

**实施清单**

- [ ] 先写 smoke test，证明 package bin 能由 Node 启动并返回受控结果；
- [ ] 创建 package metadata，名称为 `@apparux/agent-init`，版本为 `0.1.0`；
- [ ] 声明 `agent-init` bin 与 Node.js 18+ requirement；
- [ ] 建立带 shebang 的极薄 bin entry；
- [ ] 建立 `runCli(argv, runtime)` seam，但不在入口复制命令逻辑；
- [ ] 配置 Node 内置 test runner；除非出现已记录的充分理由，不增加 runtime dependency；
- [ ] 验证 `npm pack --dry-run` 能识别 package。

**完成验证**

- `npm test` 可运行；
- bin smoke test 通过；
- package 采用 ESM 且无需构建；
- 当前任务不提前实现 install/update 等业务行为。

**PRD Trace:** npm Package、package.json、Node Requirement、Repository Structure、AC-D01、AC-D07。

---

## AI-002 — 建立隔离测试工具与 temporary HOME

**Blocked by:** AI-001

**目标**

让所有 filesystem lifecycle 测试在真实但隔离的临时目录运行，绝不接触开发者 home。

**实施清单**

- [ ] 先写会检测真实 HOME 访问并失败的安全测试；
- [ ] 建立 per-test temporary HOME fixture，并隔离目标平台实际 home resolution 使用的全部环境变量；
- [ ] 建立最小 canonical mother Skill fixture；
- [ ] 支持固定 package version、clock 与 deterministic test random bytes；生产 identity 使用 Node cryptographic RNG；
- [ ] 捕获 stdout、stderr 与 exit code；
- [ ] 在 tool root、`.agents`、`.claude` 及 target siblings 中种入 foreign sentinels；
- [ ] 提供 filesystem tree/entry type/link text/mode 断言和 cleanup；
- [ ] 确保测试可并行执行且 fixture 不共享可变状态。

**完成验证**

- 故意访问真实用户 target 的测试被 guard 拒绝，spawned CLI 实际解析出的 home 必须位于 disposable root；
- foreign sentinels 在每类 lifecycle outcome 后保持不变；
- 连续与并行测试不互相污染；
- cleanup 后无遗留 temporary directory。

**PRD Trace:** CLI Testing、Project Fixtures、测试不得操作真实 `~/.agents` / `~/.claude`。

---

## AI-003 — 实现 runtime paths 与 metadata version

**Blocked by:** AI-001, AI-002

**目标**

从显式 Runtime Context 一次性解析全部路径和版本，不依赖 cwd 或硬编码用户目录。

**实施清单**

- [ ] 先覆盖 valid home、missing/invalid home、不同 path separator、case/drive/UNC 与 cwd 变化；
- [ ] 同时解析 logical home 与 physical home anchor；
- [ ] 从 module/package location 解析 package root；
- [ ] 从 package metadata 读取唯一 version；
- [ ] 推导 stable root、canonical Skill、manifest、Codex target 与 Claude target；
- [ ] 对所有 managed paths 执行 lexical + physical containment 与 ancestor no-follow validation；
- [ ] 拒绝 symlink/junction/reparse ancestor、link loop 与 retarget escape；
- [ ] 定义 distribution mutation allowlist：外部 fixed lock + operation-bound descriptor/journal/temp control entries、tool root、exact targets、operation-bound sibling staging/quarantine，以及 missing parent 的逐级 mkdir / rollback-only empty rmdir；禁止修改 parent 其他 entry，uninstall 永不删除 parent；
- [ ] 为 invalid home/path parent 返回上下文错误与 remediation；
- [ ] 完成 `--version` 行为测试与最小实现。

**完成验证**

- 输出严格为 `agent-init <package version>`；
- changing cwd 不改变 source/installation path resolution；
- 没有第二份 version constant；
- 不依赖 npm 临时执行路径作为持久 target。

**PRD Trace:** Stable Installation Directory、Version、Platform Support、AC-D02、AC-D03。

---

## AI-004 — 实现 manifest schema 与 deterministic digest

**Blocked by:** AI-002, AI-003

**目标**

建立可验证、可演进的 `install.json` 与跨机器稳定的 payload digest。

**实施清单**

- [ ] 先写 valid、missing、corrupt、unsupported schema 和 path mismatch tests；
- [ ] 定义 `schemaVersion: 1` validation；
- [ ] 验证 package、install root、canonical path、`installId` 和 per-target `targetId` records；
- [ ] 定义 installer-reserved managed-copy ownership marker，并从 payload digest 中排除；
- [ ] 实现 deterministic SHA-256 tree digest；
- [ ] 排除 mtime、absolute path 与遍历顺序；
- [ ] 对 symlink/special entry 明确接受或拒绝，不隐式跟随；
- [ ] 实现 deterministic JSON serialization；
- [ ] 确认 schema 无 credential/repository-specific field。

**完成验证**

- 相同 tree 在不同创建顺序和 mtime 下 digest 相同；
- 内容、relative path、entry type 或 executable bit 改变时 digest 改变；
- corrupt/unknown schema 不被自动“修复”；
- manifest 错误包含路径和 remediation。

**PRD Trace:** Installation Manifest、Ownership Protection、CLI Error Handling。

---

## AI-005 — 实现 managed filesystem transaction

**Blocked by:** AI-002, AI-003

**目标**

把 staging、atomic write/swap、rollback 与 safe removal 集中在一个 deep module 内。

**实施清单**

- [ ] 先写 atomic write、directory detach/swap、partial failure、hard process termination、rollback 与 containment tests；
- [ ] 为 canonical 使用 tool-root-local staging，为每个 managed-copy target 使用 physical-parent-local sibling staging/quarantine；
- [ ] 在 installation root 外建立 operation-bound immutable owner descriptor、atomically replaced journal 与 fixed atomic no-replace lock entry；foreign/invalid control path 零修改停止；
- [ ] 定义 control-set crash protocol：每次使用新的 temp write + file fsync + atomic rename/replace + supported parent fsync，完整 descriptor/journal 后才发布 fixed lock，journal 更新禁止复用 live inode 或 in-place truncate/write；平台缺少 directory fsync 时记录 weaker guarantee 并验证可用 rename/no-replace 语义；
- [ ] 实现 write-ahead intent/completion phases、commit point 与 startup recovery table；fresh install 不为加锁而提前创建 tool root，uninstall 持 fixed lock 删除 root 后再清理 control set；
- [ ] 无 fixed lock 的 orphan control temp/descriptor/journal 默认只由 doctor 报告，不自动删除；只有当前 journal 以 cryptographic operation id 明确列出的本次资产才可清理；
- [ ] 实现 manifest 临时文件 + rename；
- [ ] 实现 canonical/target detach-before-replace/delete 与 rollback record；
- [ ] 每个 mutation 前重新验证 type、ownership identity、digest/link text 与 parent identity；
- [ ] 只删除已 detach 且再次验证 owned 的 object，不对 live pathname 直接递归删除；
- [ ] 创建使用 exclusive semantics，unexpected destination 出现即停止；
- [ ] 删除时不跟随未知 symlink；
- [ ] 禁止 `EXDEV` 后退化为 live in-place copy；
- [ ] 区分 busy、foreign/invalid control path、permission、missing source、non-empty conflict、recoverable/ambiguous journal 与 rollback failure；
- [ ] 失败后返回 changed/preserved/unresolved assets。

**完成验证**

- 注入每个关键写入点失败或强制终止后，不会把健康旧安装报告为成功；
- retry 能依据 journal 回滚或完成 cleanup 并收敛；
- plan/apply race 与并发 command 不会删除或覆盖 replacement sentinel；
- 可恢复失败恢复旧内容；
- 不可恢复失败保留诊断状态并返回 `ROLLBACK_FAILED`/`ambiguous`；
- path traversal、physical ancestor escape 与 link retarget 测试全部被拒绝。

**PRD Trace:** Install、Update Workflow、Ownership Protection、CLI Error Handling、Quality Priorities。

---

## AI-006 — 实现 target inspection 与 ownership state

**Blocked by:** AI-004, AI-005

**目标**

用一套 Interface 管理 Claude/Codex target，并准确区分 owned、broken、drifted 与 foreign 状态。

**实施清单**

- [ ] 为 `missing`、`owned-valid`、`owned-broken`、`owned-drifted`、`foreign`、`ambiguous` 写表驱动测试；明确只有 unchanged link/source-missing 或 journal-proven interruption 可成为 independently removable `owned-broken`；
- [ ] 实现 symlink destination 与 stable no-follow entry identity 精确验证；平台/filesystem 无可持久比较 identity 时不得创建 managed symlink，改用 managed copy，existing identity-less link 在 destructive operation 中保留为 ambiguous；
- [ ] 实现 managed copy marker identity + payload digest 验证；
- [ ] 验证 byte-identical 但无 matching marker 的用户重建目录不会被接管；marker 匹配但 payload 被用户删改的 managed copy 仍归为 drifted/ambiguous，除非 journal 逐项证明 interrupted mutation；
- [ ] 验证 manifest record 与当前 target type 一致；
- [ ] 不通过“相同内容”接管 foreign target；
- [ ] 实现 Symlink Adapter 与 Managed Copy Adapter；
- [ ] 让两个 Adapter 返回统一 TargetState/TargetRecord；
- [ ] 对 replaced target 保守分类，不覆盖或删除。

**完成验证**

- 两个 target 复用同一状态逻辑；
- user replacement 在缺少 matching ownership identity 时成为 `owned-drifted`、`foreign` 或 `ambiguous`，即使 payload 字节相同也不会被删除；
- unchanged-link 或 journal-proven `owned-broken` 可与 foreign broken entry 及 user-edited managed copy 区分；
- target inspection 自身只读。

**PRD Trace:** Symlink Fallback、Existing Target Protection、Ownership Protection、AC-D11–AC-D13。

---

## AI-007 — 建立 lifecycle planning Interface

**Blocked by:** AI-004, AI-005, AI-006

**目标**

先完整检查并生成 operation plan，再允许任何写入；避免 install/update/uninstall 各自复制策略。

**实施清单**

- [ ] 先写 lifecycle state matrix tests；
- [ ] 定义 `executeLifecycle(request, runtime) -> LifecycleResult`；
- [ ] 把 Read-only validate/inspect → obvious-conflict zero-mutation return → Lock/Recover → Re-inspect/Classify → Plan → Revalidate → Apply → Validate/Commit 编排集中实现；
- [ ] doctor 复用 read-only Inspect/Classify/journal status，但禁止 acquire mutation lock 后写入或进入 Apply；
- [ ] plan 包含预期 create/replace/remove/preserve、asset fingerprints 与 rollback 信息；
- [ ] 每个 asset 在 mutation-time 独立 revalidate；stale plan 不授权操作；
- [ ] invalid package 与初始只读检查已确认的 obvious foreign/ambiguous/drifted conflict 在创建 control set 前零修改返回；lock 后必须重新检查以关闭 race；
- [ ] 结构化 result 与 CLI 文案解耦；
- [ ] 明确 no-op、repair、conflict 与 failure 结果。

**完成验证**

- invalid package 或初始只读检查确认的 obvious conflict 下，包含 control set 在内的 filesystem mutation count 为零；
- plan/apply 间替换 asset 时，mutation-time validation 拒绝 stale plan；
- 同 HOME 并发 mutating commands 被串行化，external replacement 仍由 identity revalidation 防护；
- 四个 lifecycle operation 使用相同 ownership classification；
- 计划与实际 changed assets 可逐项对照。

**PRD Trace:** Install、Update、Doctor、Uninstall、Preserve Before Generate、Idempotency。

---

## AI-008 — 完成 CLI parsing、output 与 error contract

**Blocked by:** AI-003, AI-007

**目标**

提供稳定、简洁、可扫描的命令体验，同时保留结构化内部错误。

**实施清单**

- [ ] 先写命令表、usage error、help、stdout/stderr 与 exit code tests；
- [ ] 支持 `install`、`update`、`doctor`、`uninstall`、`--version`、`--help`；
- [ ] unknown/multiple invalid command 返回 exit code 2；
- [ ] success/no-op/help/version 返回 0；failure/unhealthy doctor 返回 1；
- [ ] 实现稳定 error categories 与 contextual rendering；
- [ ] 默认不打印 stack trace 或底层操作日志；
- [ ] 输出 version、路径、target state/mode、结果和 remediation；
- [ ] 保持 output renderer 与 lifecycle logic 分离。

**完成验证**

- 输出 tests 不依赖临时路径之外的机器差异；
- 每类错误均说明 what/where/why/changed/next action；
- PRD 示例核心信息可被用户直接扫描与复制。

**PRD Trace:** CLI Commands、Install Output、CLI User Experience、CLI Error Handling、AC-D07。

---

## AI-009 — 实现 install 与 repair

**Blocked by:** AI-007, AI-008

**目标**

安全完成 fresh install、repeat no-op 与 owned partial repair，并把同一 canonical mother Skill 暴露给两种 Agent。

**实施清单**

- [ ] 先写 fresh、repeat、partial repair、version mismatch、foreign target、invalid payload tests；
- [ ] 修改前验证 package payload 与 mother `SKILL.md` metadata；
- [ ] 使用 journal 建立可恢复的 fresh-install commit sequence；
- [ ] 创建 stable canonical directory；
- [ ] 首选为 Codex/Claude 建立 symlink target；
- [ ] 写入 manifest 并验证 digest/targets；
- [ ] 同版本健康安装返回 no-op，零 mtime/content churn；
- [ ] 可证明 owned 的 missing/broken asset 支持 repair；
- [ ] `install` 遇到不同 installed version 时提示 `update`，不隐式升级；
- [ ] 任一 conflict 必须发生在首次写入前；
- [ ] partial failure 使用 transaction rollback。

**完成验证**

- canonical source 唯一；
- Claude/Codex target 指向或复制自该 source；
- repeat install 无破坏性结果；
- 未知 target 原样保留；
- install 后完整 validation 通过。

**PRD Trace:** Install、Codex/Claude Targets、Existing Target Protection、AC-D01–AC-D06、AC-D08、AC-D11。

---

## AI-010 — 实现 read-only doctor

**Blocked by:** AI-006, AI-008, AI-009

**目标**

以稳定 check list 诊断安装、版本、ownership 与 target 健康，不做自动修复。

**实施清单**

- [ ] 先写 healthy、not installed、corrupt manifest、missing canonical、broken target、drift、permission、busy/recoverable/ambiguous journal tests；
- [ ] 为每项 check 返回 id/status/path/message/remediation；
- [ ] 检查 installed/running version；
- [ ] 检查 canonical `SKILL.md` 与 digest；
- [ ] 检查两个 target 的 mode、destination/digest 与 ownership；
- [ ] 检查 read permission 与 stale staging/rollback；
- [ ] 汇总 Healthy/Unhealthy 与 exit code；
- [ ] 对 doctor 前后完整 filesystem tree 做相等断言。

**完成验证**

- healthy 状态 exit 0；任一 error exit 1；
- warning/error 均有最小修复建议；
- broken 与 foreign 状态不会混淆；
- doctor 严格零写入。

**PRD Trace:** Doctor、CLI User Experience、AC-D13。

---

## AI-011 — 实现 ownership-safe uninstall

**Blocked by:** AI-007, AI-008, AI-009

**目标**

只移除仍由工具拥有的用户级资产，保留被替换 target、未知数据与所有业务项目资产。

**实施清单**

- [ ] 先写 healthy uninstall、repeat uninstall、replaced target、plan/apply replacement race、drifted copy、unchanged-link/journal-proven owned-broken、unknown root file、corrupt manifest tests；
- [ ] 删除前建立完整 removal plan；
- [ ] mutation-time revalidate 后只 detach/remove `owned-valid`，以及 unchanged link/source-missing 或 journal-proven interruption 这类可独立证明的 `owned-broken` targets；managed-copy 普通 payload mismatch 必须保留；
- [ ] 只 detach/remove digest/identity 与 manifest 匹配的 canonical payload；
- [ ] 单一 independent foreign/replaced target 被保留，但不阻止移除另一个 target 与安全独立的 owned assets；
- [ ] manifest/root 含未知资产时采用保守保留或阻塞对应 ownership chain 的策略；
- [ ] 输出 removed、preserved、unresolved assets；
- [ ] 验证 project fixture tree 在 uninstall 前后字节级不变；
- [ ] 已卸载状态返回清晰 no-op。

**完成验证**

- user-replaced target 保留；
- unknown files 永不被 recursive cleanup 带走；
- tool-owned clean installation 可完整移除；unchanged-link/journal-proven broken residual 可安全清理，user-edited managed copy 保留；
- replaced Codex target 等 independent conflict 被保留时，verified Claude/canonical assets 仍按计划移除；
- target parent directories 永不删除；
- `<repository>/AGENTS.md`、`CLAUDE.md`、`.agents/`、`.claude/`、`docs/agents/` 均不在搜索范围。

**PRD Trace:** Uninstall、Ownership Protection、Project Assets Survive Uninstall、AC-D10–AC-D11。

---

## AI-012 — 完成 symlink fallback 与平台差异

**Blocked by:** AI-009, AI-010, AI-011

**目标**

在 symlink 确实不可用时安全 fallback 到 managed copy，并保持 update/doctor/uninstall 所需 ownership evidence。

**实施清单**

- [ ] 先写 stable-identity symlink、identity unavailable、identity-less existing link、capability failure、permission failure、copy failure 与 mixed-mode tests；
- [ ] 对 identity unavailable 或明确 capability errors fallback；
- [ ] permission/invalid parent 等普通错误保留原始上下文，不误判；
- [ ] 在 target physical parent 下构建 sibling staging copy，写入 ownership marker 并计算 payload digest；
- [ ] mutation-time 重新检查 target/parent identity，使用 exclusive rename，防止竞态覆盖；
- [ ] `EXDEV` 或 target-local staging failure 时停止，不原地覆盖 live target；
- [ ] 允许 Claude 与 Codex 使用不同 mode，但相同 canonical version；
- [ ] 覆盖 POSIX、WSL path assumptions 与 Windows Native best-effort link mode；
- [ ] doctor/output 显示实际 mode。

**完成验证**

- fallback copy 可被 doctor 验证；
- modified copy 被识别为 drifted；
- uninstall 不删除 drifted copy；
- fallback 不产生第二份需要人工维护的源码源。

**PRD Trace:** Symlink Fallback、Platform Support、AC-D06、AC-D12。

---

## AI-013 — 验证 npm tarball distribution lifecycle

**Blocked by:** AI-009, AI-010, AI-011, AI-012, AI-014

**目标**

从实际 `npm pack` tarball 验证安装器不依赖 source checkout 或 npm temp cache。

**实施清单**

- [ ] 先建立 tarball end-to-end test；
- [ ] 验证 package `files` 只包含必要 `bin`、`src`、`skills` 与 metadata；
- [ ] 从 tarball 在 isolated temporary HOME 执行 version → install → doctor → repeat install → uninstall；
- [ ] 删除 package extraction/cache 后再次验证 installed mother Skill 可读；
- [ ] 静态验证 packaged mother Skill frontmatter、directory/name 一致性与共享 metadata contract；
- [ ] 验证两个 discovery target 的 filesystem state；该检查不冒充 AC-D04/D05 的真实 Harness discovery 验收；
- [ ] 验证 CLI lifecycle 未修改 fixture repository；
- [ ] 检查 package 中无测试 fixture、secret 或本机绝对路径。

**完成验证**

- packed artifact 独立完成 lifecycle；
- stable canonical directory 不引用 tarball extraction path；
- distribution acceptance（update 除外）有端到端证据。

**PRD Trace:** npm Package、Stable Installation Directory、Definition of Done、AC-D01–AC-D13。

---

# Milestone 2 — Core Project Setup

## AI-014 — 建立可发现的 mother Skill skeleton

**Blocked by:** AI-001

**目标**

先建立可由 package 分发、符合共享 discovery metadata contract 的 `project-setup` skeleton；AI-015 建立 evaluation harness 与失败 behavioral evaluations，具体行为由 AI-017–AI-027 各自按 TDD 实现。

**实施清单**

- [ ] 先写静态 format test；
- [ ] 创建最小 `skills/project-setup/SKILL.md`；
- [ ] frontmatter 至少包含 `name` 与 `description`；
- [ ] `name: project-setup` 与 lowercase-hyphen directory 完全一致；
- [ ] description 清楚说明 what/when；
- [ ] canonical metadata 只使用两种 Harness 共同支持的 field；
- [ ] 建立 references 目录入口，但不在 evaluation harness 之前声称完整行为已实现；
- [ ] 确认 package files 包含 mother Skill skeleton。

**完成验证**

- 静态 metadata validation 通过；
- Skill 不复制整份 PRD；
- 两种 Agent target 可引用同一 canonical content；
- Skill 不声称有尚未实现的 helper 或 project-setup behavior。

**PRD Trace:** Project Setup Skill、Project Setup Workflow、Progressive Disclosure、Evidence First。

---

## AI-015 — 建立 project fixture/evaluation harness

**Blocked by:** AI-002, AI-014

**目标**

用行为 invariant 而非逐字 snapshot 验证 Skill 在代表性 repository 上的决策。

**实施清单**

- [ ] 定义 fixture manifest：evidence、expected classifications、allowed/forbidden paths、unknowns、second-run expectation；
- [ ] 建立 `01-java-maven-simple`；
- [ ] 建立 `02-java-maven-monorepo`；
- [ ] 建立 `03-node-pnpm`；
- [ ] 建立 `04-python`；
- [ ] 定义如何在 Claude Code 与 Codex 中启动 fresh session、注入/拒绝 approval、观察 writes 与保存人工/自动验收 evidence；
- [ ] 建立由 AI-017–AI-027 分别负责启用的 pending behavioral evaluation contracts（phase orchestration、Progressive Disclosure、approval/scope、Unknown、preservation、reconcile separation）；本任务只让 harness self-tests 通过，不把尚未实现的 contract 混入 green suite，也不提前实现产品行为；后续 owner task 必须先启用对应 contract 得到 red，再做最小实现转绿；
- [ ] 为 proposal-before-write、scope 与 preservation 建立自动检查；
- [ ] 不要求生成文本逐字一致；
- [ ] 确保 fixtures 最小但含足够交叉 evidence。

**完成验证**

- harness 能区分分类错误、scope violation、missing evidence 与 harmless wording difference；
- fixture 初始状态可重复恢复；
- evaluation 不读取 fixture 外文件。

**PRD Trace:** Project Fixtures、Project Setup Testing Focus、AC-P01–AC-P09。

---

## AI-016 — 实现 optional deterministic fact collector

**Blocked by:** AI-014, AI-015

**目标**

实现只收集确定性 repository facts 的小型 helper，不让 script 解释业务或决定生成内容。

**实施清单**

- [ ] 先写 JSON schema、stable order、no-write 与 bounded-search tests；
- [ ] 接受显式 repository root 并验证路径；
- [ ] 收集 Git presence/root/status summary；
- [ ] 收集 known build/lock/runtime indicator files；
- [ ] 收集 package manifest 与 exact script names；
- [ ] 收集 CI paths 与 existing Agent/Skill paths；
- [ ] 对 unreadable path 输出 per-check error；
- [ ] 不读取 secret values、不递归扫描整个 repository；
- [ ] 不输出 classification、architecture judgement 或 Skill recommendation。

**完成验证**

- 相同 fixture 输出稳定 JSON；
- helper 前后 tree digest 相同；
- no-Git 与 partial-permission repository 有明确结果；
- Agent 可在 helper 不可用时通过原生探索继续工作。

**PRD Trace:** Deterministic Helper Scripts、Helper Scripts 不负责、Phase 1 Explore。

---

## AI-017 — 定义并验证 Preflight 与 Explore

**Blocked by:** AI-015

**目标**

让 Skill 在任何解释或写入前建立足够可靠、可审计的 repository mental model。

**实施清单**

- [ ] 为 Git clean/dirty/untracked、no-Git 与 existing Agent config 写场景测试；
- [ ] Preflight 记录 cwd、root、Git staged/unstaged/untracked baseline、Agent files 与 Skill directories；
- [ ] Explore 顺序固定为 Search → Read relevant → Cross-check；
- [ ] 覆盖 repository shape、languages、runtime、build、verification、docs，以及 `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` / `CLAUDE.local.md` / `.agents` / `.claude` Hooks/settings / `.cursor` / Copilot instructions 等 existing agent configuration；
- [ ] 限制无目的全仓读取；
- [ ] 冲突 evidence 明确记录，不择便利结论；
- [ ] 对敏感文件默认只检测存在性；
- [ ] 确认整个 Phase 0–1 严格 read-only。

**完成验证**

- dirty repository 不被无条件拒绝；pre-existing staged/unstaged/untracked business changes 被记录并在 Apply 后保持内容与状态不变；正在修改的 Agent target 触发保守处理；
- no-Git fixture 可继续；
- Explore 结果包含 source paths 与 Unknown；
- phase 执行前后 repository tree 不变。

**PRD Trace:** Phase 0 Preflight、Phase 1 Explore、Repository Exploration Principle、Existing Agent Configuration。

---

## AI-018 — 定义 Project Profile 与 Evidence Ledger

**Blocked by:** AI-017

**目标**

把 observation、fact、source、persistence scope、deterministic flag 与 destination 分开，防止无证据事实进入持久 Context。

**实施清单**

- [ ] 定义运行时 Project Profile fields 与 Unknown semantics；
- [ ] 定义 EvidenceRecord；
- [ ] 要求每个非 Unknown profile conclusion 引用 evidence；
- [ ] 使用 repository-relative source path 与具体 key/location；
- [ ] 记录 conflicting evidence；
- [ ] 默认不把 Profile/Ledger 写入 repository；
- [ ] 为 Java、Node、Python fixture 验证 traceability；
- [ ] 验证日志/Proposal 不泄漏 secret value。

**完成验证**

- 可回答 What/Where/Why/Class/Store 五个问题；
- 缺少 evidence 时结果是 Unknown；
- profile 是中间数据而非第二事实源。

**PRD Trace:** Project Profile、Classification Evidence、Unknown Handling、AC-P09、AC-P13。

---

## AI-019 — 实现 knowledge classification behavior

**Blocked by:** AI-018

**目标**

用 persistence scope 与独立 deterministic-enforcement flag 分类知识，并避免把技术栈机械转换成配置。

**实施清单**

- [ ] 为 `GLOBAL | WORKFLOW | DISCOVERABLE | ARCHITECTURE | NONE` scope、Unknown 与 deterministic flag 建立正反例；
- [ ] 实施 DESIGN 中的两维模型与判定顺序；
- [ ] `DISCOVERABLE` 明确仅表示无独立 policy/workflow/architecture 持久价值的任务局部事实，并且不持久化；
- [ ] deterministic flag 在 v0.1 只附加 recommendation，不取代 persistence scope；
- [ ] stable + broad + pre-action relevance 的 repository policy 可以进入 GLOBAL，即使 evidence 文件可被搜索；
- [ ] 技术栈检测不自动创建 Skill；
- [ ] 无充分证据不套用行业惯例；
- [ ] 冲突结论进入 warning/Unknown 而非猜测。

**完成验证**

- Java fixture 不因 Java 本身生成 `java-backend` Skill；
- service/controller path 等事实被判为 DISCOVERABLE；
- package manager/runtime constraint 有证据时可成为 GLOBAL；package-manager enforcement 可同时带 deterministic flag；
- 每个持久化 candidate 有 destination 与 reason。

**PRD Trace:** Knowledge Classification、GLOBAL/WORKFLOW/DETERMINISTIC/DISCOVERABLE/ARCHITECTURE、AC-P03–AC-P05、AC-P09、AC-P13。

---

## AI-020 — 实现 Proposal 与 approval gate

**Blocked by:** AI-018, AI-019

**目标**

让用户在任何写入前清楚看到准备改变、保留、跳过和推荐的内容及原因。

**实施清单**

- [ ] 定义 ProposalAction schema 与唯一 action vocabulary；
- [ ] 为 CREATE/UPDATE/KEEP/SKIP/RECOMMEND 写行为 tests；CREATE 展示完整 content，UPDATE 展示 exact diff；
- [ ] 用 warning + `decisionRequired` 表示 unresolved user input，不扩展五种 canonical action；
- [ ] 展示 project summary、facts、unknowns、warnings 与 exact paths；
- [ ] 每项 action 引用 evidence 与 reason；
- [ ] 对 writable target 记录 baseline fingerprint；
- [ ] 展示 proposed diff/content、non-goals 与 validation plan；
- [ ] 在明确批准前阻止 Apply；
- [ ] 用户调整范围、拒绝、部分批准或只给模糊 acknowledgment 时按明确 contract 处理；只有对精确 Proposal 的明确批准可解锁 Apply；
- [ ] 修订 Proposal 使旧 approval 失效，不增量偷渡；
- [ ] RECOMMEND 永不自动写入。

**完成验证**

- 没有 approval 的场景 repository 零写入；
- 用户能快速识别 what/why/will-not-change；
- Proposal target drift 会使 approval 失效；
- unknown 不被隐藏。

**PRD Trace:** Proposal、Proposal Actions、Apply、Skill User Experience。

---

## AI-021 — 实现 minimal AGENTS/CLAUDE generation

**Blocked by:** AI-019, AI-020

**目标**

生成高信噪比共享规则，并让 `CLAUDE.md` 默认作为薄 Adapter 引用 `AGENTS.md`。

**实施清单**

- [ ] 为 create、existing content、Claude-specific rule 与 no-content 场景写 tests；
- [ ] 只为有内容的 AGENTS sections 生成标题；
- [ ] 排除目录树、依赖清单、class/method 清单与瞬时源码位置；
- [ ] 确保每条规则有 GLOBAL evidence；
- [ ] 默认 `CLAUDE.md` 仅复用 `@AGENTS.md`；
- [ ] 仅在有 Claude-specific evidence 时追加专属段落；
- [ ] 不在两份文件复制共享规则；
- [ ] 对已有内容生成 conservative proposed diff，不直接重写。

**完成验证**

- `AGENTS.md` minimal、stable、scannable；
- `CLAUDE.md` 保持 Adapter 深度，不成为第二规则源；
- existing AGENTS/CLAUDE fixture 的用户内容保留；
- Discoverable facts 未持久化。

**PRD Trace:** AGENTS.md、CLAUDE.md、Minimal Global Context、AC-P04–AC-P07、AC-P10–AC-P11。

---

## AI-022 — 实现 scoped Apply 与 Validate

**Blocked by:** AI-020, AI-021

**目标**

只执行 approved Proposal 中允许的 Agent asset changes，并证明未修改业务文件或并发变化的 target。

**实施清单**

- [ ] 为 allowed/forbidden paths、baseline drift、dirty baseline、symlinked/junction ancestor escape、partial failure 与 no-Git 场景写 tests；
- [ ] Apply 前重新读取 target 并比较 fingerprint；
- [ ] 只允许 PRD 指定的五类 lexical project paths，并逐段 no-follow 验证 physical target 位于 repository root；
- [ ] `.agents`、`.claude`、`docs/agents` 或其 ancestor 为 symlink/junction/reparse point 时停止，不穿透写出 repository；
- [ ] 只执行 approved CREATE/UPDATE；
- [ ] 按 AGENTS → CLAUDE → Skills → Claude references → docs 顺序写入；
- [ ] 遇到 target drift 停止并要求新 Proposal；
- [ ] partial failure 报告 changed/unchanged，不未经批准重写用户文件回滚；
- [ ] Validate 检查 scope、preservation、evidence、single source 与 Unknown；
- [ ] Git 可用时比较 final state 与 preflight baseline，只允许 approved paths 出现新增 delta；
- [ ] dry-run second pass 作为 idempotency signal。

**完成验证**

- `src/`、build files、CI、database、production config 均无改动；
- approval 与实际 diff 精确对应；
- baseline drift 下零额外写入；
- validation failure 不被报告为完成。

**PRD Trace:** Apply、Project Write Scope、Existing Configuration Preservation、AC-P10–AC-P16。

---

# Milestone 3 — Project Skills

## AI-023 — 实现 Skill candidate detection

**Blocked by:** AI-019, AI-020

**目标**

只为有 evidence、项目特有、重复且 task-specific 的 workflow 提议 Skill。

**实施清单**

- [ ] 为 build verification、migration、deployment、audit log 与技术栈-only 反例建立 tests；
- [ ] 要求明确 When to use / When not to use；
- [ ] 要求重复性、项目特异性、专项知识量与 verification；
- [ ] category 仅作为 candidate，不作为默认安装列表；
- [ ] 不满足条件时输出 SKIP 与 reason；
- [ ] 避免与 GLOBAL 或现有 Skill 重复；
- [ ] candidate action 引用 evidence。

**完成验证**

- 检测 Java/Spring/Node/Python 本身不会创建 Skill；
- 有明确项目 workflow evidence 时可稳定提出 candidate；
- 无 verification 或仅目录摘要的 candidate 被拒绝。

**PRD Trace:** Skill Candidate Detection、Candidate Categories、AC-P03、AC-P08–AC-P09。

---

## AI-024 — 实现 project Skill generation 与跨 Agent 共享

**Blocked by:** AI-022, AI-023

**目标**

创建 focused canonical project Skills，并使 Claude Code 引用同一 source，同时保守维护已有 Skills。

**实施清单**

- [ ] 为 new Skill、existing Skill、name conflict、symlink/copy fallback 写 tests；
- [ ] canonical source 使用 `.agents/skills/<skill>/SKILL.md`；
- [ ] 每个 generated Skill 先通过共享 metadata contract：`name` 与 lowercase-hyphen directory 一致，`description` 清楚说明 what/when；
- [ ] Skill body 只包含触发、非触发、workflow、project rules、verification、references；
- [ ] 不复制 `AGENTS.md`、完整 architecture 或 Discoverable implementation detail；
- [ ] Claude target 优先 relative symlink；
- [ ] symlink 不可用时，managed copy 必须在 Proposal 中明确；
- [ ] 不能安全合并 existing Skill 时 KEEP + warning/`decisionRequired`，不覆盖；
- [ ] validate canonical/Claude content consistency。

**完成验证**

- 两种 Agent 获得同一项目 workflow；
- existing Skill 内容保留；
- 每个 Skill focused、minimal、evidence-based；
- fallback copy 不被误认为新的 canonical source。

**PRD Trace:** Project Skills、Skill Generation Rules、Skill 禁止内容、Cross-Agent Sharing、AC-P08、AC-P12。

---

# Milestone 4 — Maintenance

## AI-025 — 实现 CLI update 与 rollback

**Blocked by:** AI-007, AI-008, AI-009, AI-010, AI-011, AI-012, AI-013

**目标**

安全更新 mother Skill 与工具管理的用户级资产，不扫描或修改任何业务 repository。

**实施清单**

- [ ] 先写 same-version no-op、version upgrade、downgrade refusal、same-version different-payload conflict、repair、foreign/drift conflict、plan/apply race、crash/restart 与 rollback tests；
- [ ] 校验 current package payload 与 existing ownership；
- [ ] 同 version + same package digest + healthy 返回 `Already up to date.`；同 version/different digest 为 integrity conflict；running older 拒绝 downgrade；
- [ ] 使用 durable journal stage 新 canonical payload 后原子 detach/swap；
- [ ] mutation-time revalidate 后 repair symlink，使用 target-local staging 替换 owned-valid managed copies；
- [ ] 更新 manifest version/digests/timestamp；
- [ ] 任一 foreign/ambiguous/drifted asset 在 mutation 前阻塞；
- [ ] 注入每个 durable mutation 后的 target/manifest failure 与 subprocess termination，验证 doctor 状态及 retry 恢复/收敛；
- [ ] 以 fixture repository digest 证明 update 零业务项目改动；
- [ ] 完成 tarball old-version → new-version update E2E。

**完成验证**

- successful update 后 doctor Healthy；
- no-op update 零文件 churn；
- rollback 后旧版本仍 Healthy；
- CLI update 与 project reconcile 完全分离。

**PRD Trace:** Update、Update Workflow、Tool Update 与 Project Reconcile、AC-D07、AC-D09。

---

## AI-026 — 验证 existing configuration preservation

**Blocked by:** AI-022, AI-024

**目标**

证明已有 AGENTS、CLAUDE、Skills、Hooks/settings、agent docs、override/local 与其他 Agent instructions 不会被 delete-and-regenerate、忽略冲突或静默覆盖。

**实施清单**

- [ ] 建立 `05-existing-agents` fixture；
- [ ] 建立 `06-existing-claude` fixture；
- [ ] 建立 `07-existing-both` fixture；
- [ ] 建立 `08-existing-skills` fixture；
- [ ] 在 existing fixtures 中加入 `AGENTS.override.md`、`CLAUDE.local.md`、`.claude` Hooks/settings、existing `docs/agents`、`.cursor/` 与 Copilot instructions；
- [ ] 为 compatible merge、cross-config conflict、custom prose 与 target drift 写 assertions；
- [ ] 对非默认写入目标既验证原样保留，也验证其约束被 exploration/reconciliation 看见；
- [ ] proposed diff 只修改必要位置；
- [ ] 无法安全合并时 KEEP/RECOMMEND + warning/`decisionRequired`；
- [ ] 验证 Apply 后原有有效内容仍存在；
- [ ] 验证未批准的 formatting/reordering 不发生。

**完成验证**

- AC-P10、P11、P12 每项有独立 fixture evidence；
- existing config 不被整体重写；
- conflict 被明确呈现而非隐藏选择。

**PRD Trace:** Preserve Before Generate、Existing Configuration Preservation、AC-P10–AC-P12。

---

## AI-027 — 实现 reconcile 与 idempotency

**Blocked by:** AI-022, AI-024, AI-026

**目标**

重复运行同一 mother Skill 时重新基于证据比较项目，只提议真实变化，并在无变化时 ideally zero diff。

**实施清单**

- [ ] 为 unchanged、JDK change、verification command change、new workflow 与 removed evidence 写 tests；
- [ ] reconcile 使用完整 Preflight → Explore → Profile → Classify → Proposal 流程；
- [ ] 不依赖隐藏 project manifest；
- [ ] 比较语义与内容，避免同义改写和 Markdown 重排；
- [ ] 事实变化必须有新 evidence；
- [ ] evidence 消失时不武断删除用户内容，展示 warning/proposed diff；
- [ ] unchanged second run 输出 no-op 且不写文件；
- [ ] changed run 仍要求 approval 与 baseline check。

**完成验证**

- 所有完成 setup 的 fixture 第二次 dry-run 无写入 action；
- JDK 8 → 17 等变化产生最小 UPDATE；
- 新 workflow 只产生 evidence-backed Skill candidate；
- reconcile 不更新用户级 mother Skill。

**PRD Trace:** Reconciliation、Idempotency、Unknown Handling、AC-P18。

---

## AI-028 — 完成 core repository fixture matrix

**Blocked by:** AI-027

**目标**

覆盖 PRD 要求的十类 repository，并完成 AI-027 之前已经实现的 core Project Setup behavior matrix；specialized guardrail/architecture coverage 由 AI-029/030 追加，完整 AC-P01–P18 签核留到 AI-033。

**实施清单**

- [ ] 完成/审查 fixtures 01–08；
- [ ] 建立 `09-no-git`；
- [ ] 建立 `10-mixed-monorepo`；
- [ ] 每个 fixture 定义 expected evidence、Unknown、classification、allowed actions；
- [ ] 每个 fixture 验证 proposal-before-write；
- [ ] 每个 approved fixture 验证 forbidden paths untouched；
- [ ] 每个 fixture 验证 second-run idempotency；
- [ ] 建立 AC-P01–AC-P16、AC-P18 的 core traceability report，并为 AC-P17 预留 AI-030 记录；
- [ ] 记录不能可靠自动化的验收及人工验证步骤。

**完成验证**

- Java Maven、Node/pnpm、Python、monorepo、mixed/no-Git 均有证据；
- classification、scope、preservation、evidence 与 cross-agent behavior 均被覆盖；
- 不以 exact prose snapshot 代替行为验证。

**PRD Trace:** Project Fixtures、Project Setup Testing Focus、AC-P01–AC-P16、AC-P18。

---

# Milestone 5 — Guardrails and Architecture Guidance

## AI-029 — 实现 deterministic guardrail recommendations

**Blocked by:** AI-020, AI-028

**目标**

发现可由程序强制执行的项目规则，但 v0.1 只解释和推荐，不安装或修改开发者行为。

**实施清单**

- [ ] 为 package-manager、destructive Git、generated source、main push 候选建立正反例；
- [ ] 每个 recommendation 引用 evidence；
- [ ] 说明推荐 mechanism、影响、误报风险与验证方式；
- [ ] action 始终为 RECOMMEND；
- [ ] Apply 明确跳过 Hook、CI、permission 与 user settings 修改；
- [ ] 无充分 evidence 时不推荐；
- [ ] 验证第二次运行 recommendation 稳定且不产生 diff。

**完成验证**

- setup 前后 Hook/CI/settings tree 不变；
- recommendation 可解释且非通用猜测；
- AC-P15/P16 有自动化 scope proof。

**PRD Trace:** DETERMINISTIC、Hooks/Guardrails、AC-P15–AC-P16。

---

## AI-030 — 评估 architecture guidance 并验证限制

**Blocked by:** AI-020, AI-028

**目标**

先评估 v0.1 是否需要 positive architecture observation；无论是否实现，都必须验证 Deep Module 分析不会触发自动生产代码重构。

**实施清单**

- [ ] 先写 AC-P17 negative scope test：不得生成 move class、new business module 或 production rewrite action；
- [ ] 依据 fixtures 评估 positive module-seam/coupling guidance 是否有足够 evidence 与用户价值；
- [ ] 若不值得实现，记录 `EVALUATED / DEFER` 与理由，任务可完成且不阻塞 release；
- [ ] 若值得实现，为 module seams、coupling/hotspot 与 insufficient evidence 场景写失败测试后最小实现；
- [ ] architecture knowledge 只在长期有价值时进入 `docs/agents/` proposal；
- [ ] `AGENTS.md` 只放按需入口；
- [ ] observation 使用 Detect → Describe → Recommend；
- [ ] 未批准时不创建 agent docs；
- [ ] 没有实际职责时不创建空 architecture 文件。

**完成验证**

- business source tree 在 evaluation/analysis 前后不变；
- recommendation 与 implementation task 明确分离；
- AC-P17 有 scope test；positive capability 的实现或 defer 决策均有证据。

**PRD Trace:** Deep Modules、ARCHITECTURE、Agent Documentation、AC-P17。

---

# Release Preparation

## AI-031 — 完成 package docs 与 files 清单

**Blocked by:** AI-025, AI-028, AI-029

**目标**

让发布包的安装、使用、维护、平台和安全行为可被用户正确理解。

**实施清单**

- [ ] 编写 README，默认优先推荐 `npx`；
- [ ] 文档化 install/update/doctor/uninstall/version；明确 `Already up to date` 表示相对当前 running package，并要求 global-install 用户用 `npx @apparux/agent-init@latest update`（或先更新 global package）获取最新 payload；
- [ ] 文档化 Claude `/project-setup` 与 Codex `$project-setup`；
- [ ] 解释 tool update 与 project reconcile 的区别；
- [ ] 说明 stable directory、symlink fallback、platform support 与 ownership protection；
- [ ] 说明 project setup 的 Proposal/approval、write scope、Unknown 与 non-goals；
- [ ] 检查 package `files` 与 tarball contents；
- [ ] README 将 license 标记为 release 前必须决策的事项，不在本任务自行猜测或添加 LICENSE；
- [ ] 文档命令全部在 packed artifact 上验证。

**完成验证**

- README 示例与实际 CLI output/behavior 一致；
- 未声明超出 v0.1 的能力；
- package 无开发时文件或本机路径；
- license 未确认不阻塞本任务或内部测试，但明确阻塞 AI-034。

**PRD Trace:** npm Package、CLI UX、Platform Support、Repository Structure、Definition of Done。

---

## AI-032 — 建立跨平台自动化与 smoke validation

**Blocked by:** AI-025

**目标**

在 Linux、macOS、WSL 和 Windows Native best-effort 环境验证真实 path/link/copy 行为。

**实施清单**

- [ ] 在修改 CI 前单独确认范围与回滚方式；
- [ ] Linux 与 macOS 运行完整 test suite 和 tarball lifecycle；
- [ ] WSL 运行 install/doctor/update/uninstall smoke test；
- [ ] Windows Native 运行 best-effort link/fallback smoke test；
- [ ] 覆盖 path separator、physical containment、home resolution、symlink/junction permission 与 managed copy；
- [ ] spawned CLI 隔离 `HOME`、`USERPROFILE`、`HOMEDRIVE`/`HOMEPATH` 等该平台实际使用的变量，并在 mutation 前断言 resolved home 位于 disposable root；
- [ ] 平台 failure 输出 remediation，不静默跳过；
- [ ] 记录每个平台实际 mode 与已知限制；
- [ ] 确保自动化实际 resolved home 始终指向 disposable directory，并验证 foreign sentinels 在 crash/race/retry 后不变。

**完成验证**

- 必须支持的平台均有可重复结果；
- Windows Native 的 best-effort 限制被准确记录；
- 平台自动化不访问 runner 真实 Agent directories。

**PRD Trace:** Platform Support、Node Requirement、Symlink Fallback。

---

## AI-033 — 执行 v0.1 acceptance 与 release dry run

**Blocked by:** AI-025, AI-028, AI-029, AI-030, AI-031, AI-032

**目标**

以实际 tarball 和 repository fixtures 完整验证 PRD Definition of Done，不发布远端状态。

**实施清单**

- [ ] 构建一次 release candidate tarball；
- [ ] 在 clean temporary HOME 执行 install；
- [ ] 静态验证 mother/project Skill metadata contract；
- [ ] 验证 stable canonical mother Skill 与两个 discovery target 的 filesystem state；
- [ ] 使用 temporary HOME 验证 stable canonical mother Skill、两个 discovery target 与 manifest 记录加载同一 canonical version/content，不要求登录或启动 live Harness；
- [ ] 运行 doctor 并得到 Healthy；
- [ ] recorded-run evaluator 在 fixture 上覆盖 no-approval Proposal 与零写入路径；至少一个 conforming oracle 覆盖 explore → proposal → approval → apply → validate；
- [ ] approved apply 生成固定 project Skill 后，验证其 physical file state、metadata contract 与 `.agents/skills/<skill>` canonical content 一致；
- [ ] 再次运行 project-setup 并验证 ideally zero diff；
- [ ] 从旧版 fixture 执行 update 并再次 doctor；
- [ ] 执行 uninstall 并证明 project assets 保留；
- [ ] 完成 AC-D01–D13 与 AC-P01–P18 checklist；
- [ ] 执行 security/ownership review；
- [ ] 记录所有 skipped/manual checks 与原因；
- [ ] 任何 unresolved data-loss/scope issue 阻塞 release。

**完成验证**

- 所有自动化测试通过；
- full lifecycle 与 Project Setup workflow 都有用户可检查的最终产物；
- acceptance matrix 无未解释 gap；
- release candidate 未发送到 registry。

**PRD Trace:** Acceptance Criteria、Quality Priorities、Definition of Done。

---

## AI-034 — 完成发布前决策、发布 v0.1 并验证 registry 安装

**Blocked by:** AI-033

**目标**

在项目所有者明确授权后发布 npm package，并从 registry artifact 验证最终用户路径。

**实施清单**

- [ ] 获得 package name、version、license、registry access 与发布授权确认；
- [ ] 确认 package name availability 与 release metadata；
- [ ] 确认 Git/worktree clean state、tag/commit policy 与 rollback/deprecation plan；
- [ ] 执行最终 `npm pack --dry-run` 和 test suite；
- [ ] 发布 `@apparux/agent-init@0.1.0`；
- [ ] 从 registry 使用全新 temporary HOME 执行 `npx ... install`；
- [ ] 从 registry artifact 使用 temporary HOME 验证 mother Skill metadata、两个 discovery target、repository-plane entry 与 canonical version/content 一致，不要求登录或启动 live Harness；
- [ ] 运行 doctor、version 与 uninstall；
- [ ] 验证项目资产不受 uninstall 影响；
- [ ] 记录 published version、artifact integrity 与已知限制。

**完成验证**

- registry package 可通过 PRD 推荐命令使用；
- installed artifact 与 release candidate 一致；
- doctor Healthy，uninstall ownership-safe；
- 若发布失败，真实报告状态，不重复发布或改变 version，直到确认下一步。

**PRD Trace:** AC-D01、Definition of Done。

---

## 3. Acceptance Criteria 映射

### Distribution

| PRD AC | 主要任务 |
|---|---|
| AC-D01 | AI-001, AI-009, AI-013, AI-034 |
| AC-D02 | AI-003, AI-009 |
| AC-D03 | AI-003, AI-013 |
| AC-D04 | AI-014, AI-033, AI-034 |
| AC-D05 | AI-014, AI-033, AI-034 |
| AC-D06 | AI-006, AI-009, AI-012 |
| AC-D07 | AI-008, AI-009–AI-011, AI-025 |
| AC-D08 | AI-009 |
| AC-D09 | AI-025 |
| AC-D10 | AI-011, AI-033 |
| AC-D11 | AI-006, AI-009, AI-011 |
| AC-D12 | AI-006, AI-012 |
| AC-D13 | AI-010 |

### Project Setup

| PRD AC | 主要任务 |
|---|---|
| AC-P01 | AI-015–AI-019, AI-028 |
| AC-P02 | AI-015–AI-019, AI-028 |
| AC-P03 | AI-019, AI-023 |
| AC-P04 | AI-019, AI-021 |
| AC-P05 | AI-019, AI-021 |
| AC-P06 | AI-021, AI-024 |
| AC-P07 | AI-021 |
| AC-P08 | AI-023, AI-024 |
| AC-P09 | AI-018, AI-019, AI-023 |
| AC-P10 | AI-021, AI-022, AI-026 |
| AC-P11 | AI-021, AI-022, AI-026 |
| AC-P12 | AI-024, AI-026 |
| AC-P13 | AI-018, AI-019 |
| AC-P14 | AI-022, AI-028 |
| AC-P15 | AI-022, AI-029 |
| AC-P16 | AI-022, AI-029 |
| AC-P17 | AI-030 |
| AC-P18 | AI-027, AI-028 |

---

## 4. Release-blocking unknowns

以下事项不能从 PRD 安全推断，实施过程中必须保持显式 Unknown，直到项目所有者决定：

- [ ] npm package license；
- [ ] npm organization/package publish access；
- [ ] release branch、tag 与 changelog policy；
- [ ] CI provider 与允许修改的 workflow scope；
- [ ] Windows Native 的最低承诺级别是否在 v0.1 发布说明中进一步收窄。

这些 Unknown 不应被默认值偷偷替代。其中 license 与 registry access 只阻塞 AI-034；其余事项应在对应任务开始前解决或记录为明确限制。
