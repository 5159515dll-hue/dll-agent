# dll-agent Self-Improvement

dll-agent 的自我改进系统，包含 supervisor、gates、skills、evidence 四个核心组件。

## 系统架构

```
triggers.ts ──→ supervisor.ts ──→ gates.ts ──→ final completion
                    │                  │
                    ▼                  ▼
              skill-registry.ts   evidence.ts
                    │
                    ▼
              skills.ts ──→ skill-loader.ts
```

## 各模块职责

### triggers.ts
识别事件和信号：用户纠偏、工具失败、权限拒绝、上下文过长、完成声明、reviewer 冲突。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### supervisor.ts
核心自动监督器：监听消息流、统计失败、上下文长度、用户纠偏，满足条件时自动强制插入 reviewer subtask。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### gates.ts
Evidence gate、reconciliation gate、Goal Contract gate、final completion gate 的判定标准。所有 gate 判断基于代码，部分需要模型辅助时通过 reviewer 完成。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### goal-contract.ts (Phase 1.1)
最小 Goal Contract runtime：持久化 user goal、success criteria、success criteria status、non-goals、constraints、required verification、active plan，并提供 `assessGoalCompletion()` 给 task-state、final gate、continuation gate 使用。
- 原始 `user_goal` 创建后不覆盖；后续只允许 append/refine criteria、non-goals、constraints、required verification。
- `pending` / `blocked` success criteria 和 active plan 会阻断 final PASS。
- `non_blocking` follow-up 不阻断 verified complete。
- 缺 required verification 时只能是 `UNVERIFIED_PARTIAL` 或继续执行，不能写 verified complete。
- 创建、更新、refine、评估均写入脱敏 evidence。
**状态**: implemented_runtime_verified（Phase 1.1）。

### evidence.ts
Evidence 日志系统：自动脱敏、写入 evidence file。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### skill-registry.ts
内置技能声明（纯数据，无副作用）。定义 9 个技能及其完整约束。
**代码模式**: ✅ 已完成 flat exports + self-reexport。

### skills.ts
纯函数 skill 激活/停用逻辑。从 skill-registry 中按触发条件选出当前应激活的技能。
**代码模式**: ✅ 已完成 flat exports + self-reexport。

### skill-loader.ts
技能三层加载控制器：metadata only → summary mode → full mode。
**代码模式**: ✅ 已完成 flat exports + self-reexport。

### cost-cap.ts
成本上限：按 session 累计模型调用费用，达到上限时发出警告或阻断。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### profile.ts
dll-agent 配置 profile：quality mode、verify mode、role roster、system prompt generation。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

### interfaces.ts
全量 TypeScript 接口定义：SupervisorState、ReviewerOutput、EvidenceGateResult、CooldownStatus、CostCap 等。
**代码模式**: 已是 top-level exports（无 namespace），无需变更。

### permission-classifier.ts (NEW — Phase 1)
Risk-based 权限分类器：将 shell 命令和文件操作按风险等级分类（low/medium/high）。
- 低风险（只读、安全诊断、项目内类型检查/测试）→ auto-allow
- 中风险（项目内写入、git commit、依赖安装）→ confirm-once
- 高风险（破坏性命令、secrets、全局修改、远程推送）→ always confirm 或 block
**代码模式**: ✅ flat exports。

### lsp-strategy.ts (NEW — Phase 2)
LSP 预热策略：检测项目主语言，只预热主语言 LSP，辅助语言 LSP 保持 lazy。
- 支持三种模式：lazy / project-main / all-detected
- 自动排除 node_modules、.git、dist、.venv 等目录
- 预热最多读取 N 个代表性源码文件，不扫描全仓库
**代码模式**: ✅ flat exports。

### ux-state.ts (NEW — Phase 3)
统一 UX 状态模型：聚合 task、supervisor、permissions、tools、cost、evidence 六维状态。
- 提供 compact / normal / debug 三种输出模式
- 状态支持纯函数 mutation（setGoal、setPhase、markRecoveryAttempt 等）
**代码模式**: ✅ flat exports。

### actionable-error.ts (NEW — Phase 3)
可执行错误构建器：将 raw error 转换为分类后的可执行建议。
- 自动分类 16 种错误类型（typecheck_error、test_failure、permission_denied、config_error、provider_normalization_error 等）
- 输出包含：what failed、why likely、next automatic action、user action if required
- 生成 failure fingerprint 用于去重
**代码模式**: ✅ flat exports。

### recovery-loop.ts (Phase 3)
Autonomous Recovery Loop 最小 runtime policy：从真实 tool failure 中提取失败、分类、生成 fingerprint、检查 recovery budget，并决定 commander 自动继续、升级 reviewer、还是输出 blocked report。
- 普通 typecheck/test/import/path/config/provider normalization 错误默认自动继续。
- 同一 failure fingerprint 第二次升级 `chief-engineer`，第三次升级 `role-cross`。
- permission denied、secrets/token/login、破坏性命令、push/release/upload、全局系统修改、高成本/预算阻断输出 `BLOCKED_USER_REQUIRED` 或 `BLOCKED_BUDGET_EXHAUSTED`。
- prompt supervisor loop 已接入：写 `recovery.decision` evidence，自动恢复 hint 注入 commander，必要 reviewer 进入 subtask 队列。
**状态**: implemented_runtime_verified（Phase 3 最小闭环）。

### result-ledger.ts / deduplication-gate.ts / result-sufficiency-gate.ts (Phase 4)
Result Ledger / Dedup Hard-block / Stale Detection 最小 runtime policy：用结构化 `ResultPacket` 传递已完成工作，避免模型重复执行已经 verified 的任务。
- `queryResults(..., { reusable_only: true })` 会排除 stale / invalidated packet，即使旧 packet 的 `reusable` 标记没有同步更新。
- `checkResultSufficiency()` 会把缺 evidence refs 或缺 passed verification 的 `VERIFIED_COMPLETE` 降级为 `sufficient_but_unverified`，不能直接复用为最终完成证据。
- `files_changed[].hashAfter` 会和当前文件 bytes 做 sha256 对比；hash 变化时 verdict 为 `stale`，写入 `result.stale_detected` evidence。
- `buildDedupDispatchDecision()` 将 `reuse_existing` 转换为 dispatch hard skip；reviewer dispatch 已跳过重复 reviewer，commander final claim 必须明确复用已有 packet 或给出 redo justification。
- `finalGate()` 在存在 Goal Contract 时要求匹配的 `VERIFIED_COMPLETE` ResultPacket；自然语言 summary 不能替代 Result Ledger。
**状态**: implemented_runtime_verified（Phase 4 最小闭环）。低层 tool-call 全局拦截、跨 session 结果共享、cross-review council 消费 ledger 仍是 partial/missing。

### cross-review.ts (NEW — Phase 5)
多模型对抗交叉审查系统（Cross-Review Council）。
- 触发条件：重复失败、reviewer 冲突、高风险完成、证据不足、用户纠偏
- 结构化 council packet — 所有 reviewer 基于同一证据判断
- Council packet 读取同 session Result Ledger snapshot，包含 verified/partial/failed/stale result、reusable packet id、evidence refs、unresolved items，避免 reviewer 忽略已有结果。
- Reviewer 输出结构化（blocking、confidence、findings、required_verification）
- role-cross 仲裁冲突（基于 evidence，不是投票）
- council 受 cooldown 和 cost guard 限制
**代码模式**: ✅ flat exports。

### role-model-registry.ts (NEW — Phase 8)
统一 Role Model Registry：所有 dll-agent 角色的模型来源走同一个解析逻辑。
- 覆盖顺序：TUI/`/role-model-set` explicit session override > session override > project override > global override > built-in default > Provider default fallback
- 支持 11 个角色（含 3 个 future role）
- Fallback chain 解析：primary 不可用时自动使用 fallback
- Provider 可用性 hint（API key env var check，仅诊断；最终以 OpenCode Provider.Service 为准）
- Voice/TTS 模型 guard（禁止用于 coding role）
- 配置冲突检测（global + project 同时定义同一角色）
- 所有模型变更写入 evidence
**代码模式**: ✅ flat exports。

### Correctness-Aware Model Routing Policy (P1)
模型路由目标不是单纯少调用模型，而是在用户目标完成、正确性、evidence 充分性和安全边界优先的前提下，拦截重复、过期、无证据、无触发条件、低价值的模型调用。
- 普通低风险任务默认 commander 单独执行。
- 用户纠偏必须触发 requirements-inspector。
- repeated failure 必须升级 chief-engineer / role-cross。
- final claim 缺 evidence 必须触发 final gate / verifier；高风险 final claim 可触发 final-auditor。
- high-risk provider/routing/gate/evidence/permission 修改允许 2-3 个必要 reviewer，不受低风险默认 1 reviewer 限制。
- 每次 commander/reviewer/subtask/fallback/skipped reviewer 都写 `model.routing_decision` evidence，包含 correctness_reason 与 cost_reason。

### Provider request normalization (P0)
`reasoningEffort` 的最终兜底在 `session/llm.ts` 合并 model/agent/variant options 后执行，再进入 `ProviderTransform.providerOptions()`。
- provider/model 支持 `max` 时保留。
- provider/model 只支持 `low|medium|high` 时 `max -> high`。
- provider/model 不支持 reasoning effort 时删除该字段。
- registry 或 wrapper 仍带 `max` 时也不会发送非法 `reasoning_effort=max`。

## 实现状态

### ✅ 已由底层代码实现

| 特性 | 文件 | 说明 |
|---|---|---|
| 消息流分析（triggers） | `triggers.ts` | 检测用户纠偏、工具失败、权限拒绝、上下文信号、完成声明 |
| 真工具证据检测 | `triggers.ts:verifiedToolEvidence()` | 扫描 bash/test 工具输出，判断是否包含实际 pass/exit-0 |
| 自动 supervisor 决策 | `supervisor.ts:decide()` | 根据 6 条规则自动触发 reviewer |
| Cooldown 控制 | `supervisor.ts:isCooldown()` | 每 reviewer 每 session 最多 5 次，全局最多 12 次 |
| 风险判定 | `supervisor.ts:assessRisk()` | 基于工具失败、用户纠偏、上下文、证据缺失综合评分 |
| Reviewer subtask 生成 | `supervisor.ts:generateSubtasks()` | 自动生成强制 reviewer subtask 并注入消息流 |
| Verifier subtask 生成 | `supervisor.ts:buildVerifierSubtask()` | 生成 typecheck + test + doctor 验证任务 |
| Evidence gate | `gates.ts:checkEvidenceGate()` | 完成声明必须通过 evidence gate |
| Reconciliation gate | `gates.ts:checkReconciliationGate()` | 完成声明必须吸收 reviewer 结论 |
| Final gate | `gates.ts:finalGate()` | 综合所有条件判定是否允许完成 |
| Gate hint 注入到消息流 | `prompt.ts` (gatePendingHints) | gate block 时 synthetic_hint 作为 synthetic text part 注入到 conversation，commander 可看到反馈 |
| Role-cross JSON 输出模板 | `supervisor.ts` (role-cross template) | role-cross reviewer 输出包含结构化 JSON 模板，可被 parseReviewerOutput() 解析 |
| Evidence 日志 | `evidence.ts` | 自动脱敏写入，支持 session 级记录 |
| Secrets redaction | `evidence.ts:redact()` | 6 种 secret pattern 覆盖 + 敏感字段名匹配，JSON-safe 遍历 |
| Session state redaction | `evidence.ts:redact()` + supervisor/skills/cost-cap | 所有 session state 写入前统一调用 redact() |
| Cost 追踪 | `cost-cap.ts:computeSessionCost()` | 从消息流计算累计成本 |
| Cost 上限检查 | `cost-cap.ts:checkCap()` | session cap + 各 provider 子上限 |
| Quota/balance 刷新 | `dll-agent-quota` (Python) | TTL=300s 自动刷新，stale fallback，区分 provider billed vs local est. |
| Usage/quota UI 语义 | `context.tsx` + `dll-agent-panel.tsx` | "local est." vs "provider billed" vs "provider balance" 明确标注 |
| Skill 系统 | `skill-registry.ts` + `skills.ts` + `skill-loader.ts` | 9 个内置技能（含 self-upgrade），信号驱动激活，fingerprint 去重 |
| 技能激活逻辑 | `skills.ts:activate()` | 含 fingerprint 去重和 3 层 cooldown |
| 技能三层加载 | `skill-loader.ts` | metadata/summary/full output |
| 结构化输出 | `skill-loader.ts:SkillActivationOutput` | 每个技能激活产出结构化报告 |
| Bash 命令拦截 | `skills.ts:checkForbiddenCommand()` | 技能 forbiddenCommands 硬阻断 |
| dll-agent profile | `profile.ts` | quality/verify mode、role roster、system prompt |
| Auto-allow-all | `profile.ts:autoAllowAll()` + `agent/agent.ts` | dll-agent 启用后自动放行所有工具权限 |
| MCP 管理器 | `mcp-manager.ts` | 配置驱动声明、按需启动、互斥锁、healthcheck、degrade/cooldown |
| MCP 管理桥接 | `mcp-manager.ts:fromCatalogRegistration()` | 桥接 tool-catalog → mcp-manager，提供 McpRegistration 类型 |
| 脚本工具箱 | `toolbox.ts` | 9 个内置脚本（typecheck/test/python/doctor/git-diff/quota/smoke），+ tools/MCP doctor 检查 |
| 升级守卫 | `upgrade-guard.ts` | 升级前 smoke、失败自动回滚指令、upgrade evidence 写入 |
| 全局工具目录 | `tool-catalog.ts` | 12 个默认工具/MCP 声明（doc/docx, pdf, ppt/pptx, xlsx, github, playwright, engineering-test, observability, repo-doctor, security-redaction, docs-sync, test-gate）；含 start_policy / injection_policy / heavy 标记 |
| 项目工具叠加 | `tool-overlay.ts` | project overlay 加载、global+project merge、effective manifest 写入 session state + evidence |
| 最小 prompt 注入 | `tool-prompt.ts` | prompt index（≤1200 chars）+ on-demand 按需加载详细说明（≤1500/tool, ≤3000/round） |
| 工具 slash 命令 | `profile.ts:roleCommands()` | /tools, /tools-reload, /tools-status, /mcp-status, /mcp-start, /mcp-stop, /mcp-health |
| 全局 manifest 文件 | `~/.dll-agent/global/tools.jsonc` | 12 个默认工具能力注册（JSONC 格式，支持 project overlay 叠加） |
| 工具系统测试 | `test/dll-agent/tools.test.ts` | 58 tests covering catalog, overlay/merge, prompt injection, MCP mutex, doctor, evidence |
| **Risk-based 权限分类 (NEW)** | `permission-classifier.ts` | 命令/文件操作按风险分级；14 类 secret pattern 检测；破坏性/远程发布/全局修改分类；37 tests |
| **LSP 预热策略 (NEW)** | `lsp-strategy.ts` | 项目主语言检测 + 主语言 LSP 预热 + 辅助语言 lazy；排除目录保护；10 tests |
| **UX 状态模型 (NEW)** | `ux-state.ts` | 6 维统一状态聚合；compact/normal/debug 输出；pure function mutation API；27 tests |
| **可执行错误构建 (NEW)** | `actionable-error.ts` | 14 种错误自动分类；自动恢复建议；recovery budget 控制；failure fingerprint 去重 |
| **Cross-Review Council (NEW)** | `cross-review.ts` | 多模型对抗审查；7 种触发条件；独立 reviewer + role-cross 仲裁；candidate solution ranking；33 tests |
| **硬编码路径修复 (NEW)** | `skill-registry.ts` | 移除 /Users/dailulu 硬编码路径，改为 $HOME 和相对路径 |
| **Cross-review council 接入 (NEW)** | `prompt.ts` | checkCrossReviewTrigger() 接入 supervisor 决策循环，触发条件满足时自动注入 council reviewers |
| **Tool prompt 注入 (NEW)** | `prompt.ts` | buildPromptIndex() 注入 system prompt array，≤1200 chars |
| **Actionable error 接入 (NEW)** | `prompt.ts` | buildActionableError() 在 gate block 时注入 recovery suggestion |
| **Continuation Gate (NEW)** | `continuation-gate.ts` + `prompt.ts` | Kimi task-completion-archivist 检查 blocking unfinished items；continuation packet 生成；budget 控制；在 evidence gate 前运行 |
| **Goal Contract Gate (Phase 1.1)** | `goal-contract.ts` + `task-state.ts` + `gates.ts` + `continuation-gate.ts` + `prompt.ts` | commander 首轮创建 Goal Contract；task-state 暴露 goal_status；final gate/continuation gate 读取 contract，未满足 success criteria、active plan 或 verification 时不允许 final PASS |
| **Completion / Continuation Closure (Phase 2)** | `continuation-gate.ts` + `prompt.ts` | final report 前运行 continuation check；active plan、verification not_run、doctor failed、reviewer block 会生成 continuation packet；packet 可形成 commander/chief-engineer/requirements-inspector dispatcher action；budget exhausted 输出 BLOCKED report |
| **Autonomous Recovery Loop (Phase 3)** | `recovery-loop.ts` + `actionable-error.ts` + `prompt.ts` | 从 tool failure 生成恢复决策；普通错误自动继续；repeated fingerprint 升级 chief-engineer/role-cross；权限/secrets/破坏性/发布/预算问题输出 blocked report |
| **Result Ledger / Dedup Hard-block (Phase 4)** | `result-ledger.ts` + `result-sufficiency-gate.ts` + `deduplication-gate.ts` + `gates.ts` + `prompt.ts` | verified result 可复用；缺 evidence/verification 的结果不能复用为完成；hash changed 判 stale；重复 reviewer dispatch 硬跳过；Goal Contract final PASS 必须有 verified ResultPacket |
| **Tool-prompt project overlay (NEW)** | `prompt.ts` | loadProjectOverlay() + buildEffectiveManifest() 替换 buildGlobalEffective()，项目级工具配置生效 |
| **UX state TUI 接入 (NEW)** | `dll-agent-panel.tsx` | uxLine() memo 驱动 buildCompactSummary()，TUI 面板实时显示 task/supervisor/cost 状态 |
| **Capability Runtime Orchestrator (NEW)** | `capability-orchestrator.ts` + `capability-action-runner.ts` + `prompt.ts` | 用户目标 → registry merge → capability plan → resolver → low-risk action runner / skill intents / MCP requests / gate context；在 `resolveTools()` 前通过 OpenCode `MCP.Service.add()` 接入可自动连接 MCP |
| **Capability Status Direct Renderer (NEW)** | `capability-status.ts` + `command/index.ts` | `/capability-status` 直接读取真实 registry/resolver/runtime 状态，不再只是 commander prompt 模板 |
| **Capability TUI Sidebar (NEW)** | `capability-status.ts` + `sidebar/capability.tsx` | TUI sidebar 直接消费 capability status compact summary；无任务时显示 registry/on-demand 摘要，有任务 todo 时显示 task selected / mcp auto / task permission；30s active / 60s idle 刷新，失败降级显示 unavailable |
| **MCP healthUrl probe (NEW)** | `mcp-manager.ts` | 本地 `healthUrl` 通过 curl probe 检查；remote healthUrl 默认跳过以避免无授权外部网络访问 |
| **Artifact Ledger + Evidence Normalizer (NEW)** | `artifact-ledger.ts` + `evidence-normalizer.ts` + `gates.ts` | 审计脚本、截图、报告等任务产物被分类为 artifact evidence；浏览器审计报告+截图可作为 real tool evidence，但报告中存在 FAIL/矛盾摘要时会阻断 verified completion |
| **Completion Readiness Gate (NEW)** | `completion-readiness.ts` + `gates.ts` + `prompt.ts` | final claim 统一经过 readiness 判定；FAIL、blocker、pending reviewer、supervisor block 均禁止写 VERIFIED_COMPLETE |
| **Report Validator / Redactor (NEW)** | `report-validator.ts` + `artifact-ledger.ts` | 生成的 audit report 会自动脱敏 password/token/JWT/API key；检测 FAIL/“无阻断”矛盾、指标不一致、未覆盖项，阻止虚假 PASS |
| **Session Gate Reconciler (NEW)** | `session-reconciler.ts` + `prompt.ts` | resumed/long session 中旧的 no-evidence gate block 会在发现 artifact/result evidence 后清理或重分类，避免历史状态导致无限卡住 |
| **Artifact Result Backfill (NEW)** | `artifact-result-ledger.ts` + `evidence-normalizer.ts` | artifact report/screenshots/scripts 自动补写 Result Ledger，避免 live task 有报告但 `results.jsonl` 为空 |
| **Task Artifact State TUI (NEW)** | `task-state.ts` + `capability-status.ts` + `sidebar/capability.tsx` | sidebar 显示由 artifact/result/supervisor 推导出的 task verified/partial/blocked 状态，抵消模型 Todo 过期问题 |

### Phase 1.1 Goal Contract 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Goal Contract 持久化 user goal | implemented_runtime_verified | `ensureGoalContract()` 在 commander prompt path 创建；已测试不覆盖原始目标 |
| append/refine criteria/non-goals/constraints/verification | implemented_runtime_verified | `refineGoalContract()` 只追加/更新结构化字段，不替换 `user_goal` |
| success criteria status 驱动 gate | implemented_runtime_verified | `pending` / `blocked` criteria 使 `assessGoalCompletion()` 返回 `CONTINUATION_REQUIRED` |
| active plan tracking | implemented_runtime_verified | `updateGoalPlan()` + task-state + continuation gate 读取 active plan |
| Final Gate 读取 Goal Contract | implemented_runtime_verified | `finalGate()` 写入 `goal_contract.evaluated` evidence，未满足 contract 时阻断 PASS |
| Continuation Gate 读取 Goal Contract | implemented_runtime_verified | final report 文本无 unfinished marker 时，contract 中 pending plan 仍会生成 continuation packet |
| non-blocking follow-up | implemented_runtime_verified | `non_blocking` plan/criteria 不阻断 verified complete |
| required verification 缺失 | implemented_runtime_verified | `assessGoalCompletion()` 返回 `UNVERIFIED_PARTIAL`，不能 claim verified complete |
| 自动 continuation dispatch | implemented_runtime_verified | Continuation packet 被转换为 dispatcher-ready action；commander action 作为 synthetic hint，chief-engineer/requirements-inspector action 会进入 reviewer subtask 队列 |
| Goal Contract doctor check | implemented_runtime_verified | doctor 检查 schema/必需字段；warn/failed 语义不伪装 |

### Phase 2 Completion / Continuation Gate 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Final report 前 continuation check | implemented_runtime_verified | `prompt.ts` 在 evidence gate 前调用 `checkContinuationGate()` |
| active plan 未完成阻断 PASS | implemented_runtime_verified | Goal Contract pending plan 生成 `PARTIAL_CONTINUED` packet |
| required verification not_run 阻断 verified complete | implemented_runtime_verified | 有 Goal Contract required verification 且无真实验证证据时生成 continuation packet |
| doctor failed 阻断 PASS | implemented_runtime_verified | `blocked_completion + block_reason` 进入 continuation assessment |
| reviewer block 阻断 PASS | implemented_runtime_verified | reviewer block reason 进入 continuation packet 的 reviewer_blocks |
| final report 状态表 false positive | implemented_runtime_verified | Markdown 状态表中的 PASS/PARTIAL/FAIL 不会单独触发 blocking unfinished |
| non-blocking follow-up | implemented_runtime_verified | 有验证证据时 non-blocking plan/follow-up 不阻断完成 |
| continuation packet dispatcher action | implemented_runtime_verified | `buildContinuationDispatchPlan()` 支持 commander、chief-engineer、requirements-inspector |
| budget exhausted blocked report | implemented_runtime_verified | `buildBudgetExhaustedReport()` 输出 `BLOCKED_BUDGET_EXHAUSTED`，明确禁止 claim `VERIFIED_COMPLETE` |
| full autonomous recovery loop | partial_runtime | Phase 3 已完成最小 runtime recovery policy；完整工具执行闭环仍依赖 commander/reviewer 后续执行与验证 |

### Phase 3 Autonomous Recovery Loop 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| failure classifier | implemented_runtime_verified | `actionable-error.ts` 分类 typecheck/test/permission/gate/reviewer/dependency/path/config/provider normalization 等错误 |
| failure fingerprint | implemented_runtime_verified | `buildFailureFingerprint()` 归一化路径和数字；`recovery-loop.ts` 用 fingerprint 追踪 repair budget |
| recovery budget | implemented_runtime_verified | `repair_counts` 按 fingerprint 计数；超限输出 `BLOCKED_BUDGET_EXHAUSTED` |
| automatic repair loop policy | implemented_runtime_verified | recoverable failure 注入 `dll-agent-recovery-loop` hint，要求 commander 继续修复并验证 |
| verification loop guidance | implemented_runtime_verified | recovery decision 带 `verification` 列表，如 rerun typecheck/tests/provider smoke |
| repeated failure escalation | implemented_runtime_verified | 同 fingerprint 第二次 -> chief-engineer，第三次 -> role-cross |
| blocked with evidence | implemented_runtime_verified | permission/secrets/destructive/push/global/budget 阻断写 `recovery.blocked` evidence |
| no-stop-on-normal-error policy | implemented_runtime_verified | 普通 typecheck/test/config/provider normalization 错误不要求用户介入 |
| actual code patch execution | partial_runtime | Phase 3 负责 runtime policy 和 prompt/subtask dispatch；具体修复仍由 commander/reviewer tool loop 执行并受权限策略约束 |

### Phase 4 Result Ledger / Dedup / Stale 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| ResultPacket write/query | implemented_runtime_verified | `writeResult()` / `queryResults()` 维护 session-scoped JSONL；`reusable_only` 排除 stale/invalidated packet |
| Result Sufficiency Gate | implemented_runtime_verified | `checkResultSufficiency()` 区分 sufficient、verify_existing、partial、failed、stale、invalidated |
| missing evidence cannot reuse | implemented_runtime_verified | `VERIFIED_COMPLETE` 缺 `evidence_refs` 或 passed verification 会降级为 `sufficient_but_unverified` |
| file hash stale detection | implemented_runtime_verified | `files_changed[].hashAfter` 与当前文件 sha256 不一致时 verdict=`stale` |
| reviewer dedup hard-block | implemented_runtime_verified | `supervisor.generateSubtasks()` 发现 reusable verified reviewer result 时不再派发 reviewer，并写 routing/evidence |
| commander duplicate completion guard | implemented_runtime_verified | `prompt.ts` final loop 要求 commander 明确复用已有 packet 或说明 redo reason |
| Final Gate reads Result Ledger | implemented_runtime_verified | 有 Goal Contract 时 final PASS 必须存在 matching `VERIFIED_COMPLETE` ResultPacket |
| stale result reuse | implemented_runtime_verified | stale/expired/hash changed result 只能 reverify/redo，不能作为 final PASS 依据 |
| cross-session result sharing | missing | 当前仍是 session scoped，不跨 session 复用 |
| global low-level tool-call dedup | partial_runtime | reviewer dispatch 与 final completion 已接入；单个底层 tool call 尚未全局拦截 |
| cross-review council ledger consumption | implemented_runtime_verified | `cross-review-bridge.ts` 将 session Result Ledger snapshot 写入 council packet 和 `cross_review.council_triggered` evidence；跨 session comparison 仍未实现 |

### Phase 5 Correctness-Aware Routing / Multi-model Review 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 普通短任务不触发 reviewer | implemented_runtime_verified | supervisor tests 覆盖 default commander path |
| 用户纠偏触发 requirements-inspector | implemented_runtime_verified | correctness-aware routing tests 覆盖 user correction |
| repeated failure 触发 chief-engineer / role-cross | implemented_runtime_verified | recovery loop + supervisor tests 覆盖 second/third same fingerprint |
| high-risk 允许多个 reviewer | implemented_runtime_verified | high-risk repeated failure 可路由 requirements-inspector + chief-engineer |
| final evidence missing gate | implemented_runtime_verified | evidence/final gate 和 verifier subtask 覆盖无真证据完成声明 |
| routing evidence | implemented_runtime_verified | `model.routing_decision` 包含 correctness_reason / cost_reason |
| council consumes Result Ledger | implemented_runtime_verified | council packet 包含 session Result Ledger snapshot、evidence refs、unresolved items |
| reviewer output protocol | implemented_runtime_verified | reviewer prompts 包含 machine-readable JSON template；parse/mark 完成后写 ResultPacket |
| reconciliation gate | implemented_runtime_verified | completed reviewer 未被 commander 吸收时阻断 final completion |
| cross-session council result comparison | missing | 当前只消费当前 session ledger，不做跨 session 结果仲裁 |

### ⚠️ 只是配置层实现（需要环境变量）

| 特性 | 说明 |
|---|---|
| Quality mode (max/auto/balanced/economy) | 通过 `DLL_AGENT_QUALITY` 环境变量配置 |
| Verify mode (strict/normal/light) | 通过 `DLL_AGENT_VERIFY` 环境变量配置 |
| Auto-allow-all 开关 | 通过 `DLL_AGENT_AUTO_ALLOW` 环境变量控制 |
| Evidence file 路径 | 通过 `DLL_AGENT_EVIDENCE_FILE` 环境变量配置 |
| Cost cap | 通过 `DLL_AGENT_COST_CAP_USD` 环境变量配置 |
| dll-agent 启停 | 通过 `DLL_AGENT_ENABLED` 环境变量控制 |

### ⚠️ 部分实现（底层逻辑有，但未完成全链路接入）

| 特性 | 现状 |
|---|---|
| 工具失败信号直接接入 trigger | 目前通过正则检测，未直接从 tool error state hook |
| Typecheck 失败直接接入 trigger | 目前通过 regex 检测，未从 tsgo exit code hook |
| Doctor 失败直接接入 trigger | 目前通过 regex 检测，未从 doctor exit code hook |
| Permission denied 直接接入 trigger | 已从 tool part state 检测（`triggers.ts:60-68`） |
| Evidence 缺失直接接入 gate | 已通过 `verifiedToolEvidence()` + regex 双重检测 |

### 📋 计划中（尚未实现）

| 特性 | 说明 |
|---|---|
| MCP runtime 全链路接入 | capability-orchestrator 已在 session loop 中按需调用 `MCP.Service.add()`，使选中 MCP 进入 `mcp.tools()`；mcp-manager 仍只负责 dll-agent 侧状态收敛/managed cleanup，不替代 OpenCode MCP 生命周期 |
| on-demand MCP auto-start | 已实现最小闭环：基于用户目标和 registry triggers 自动规划 MCP，并在无凭据/登录态/发布/破坏性风险时自动接入；涉及 secrets、登录态、远程发布或破坏性操作仍要求确认或阻断 |
| TUI quota 显示组件 | 已实现 dll-agent-panel.tsx，但需验证 |
| Permission classifier 接入 Permission.Request | permission-classifier.ts + permission-bridge.ts 已实现，桥接到 src/permission/index.ts；permissionPreCheck() 已在 Permission 评估管线中调用 |
| LSP strategy 接入 LSP launch pipeline | lsp-strategy.ts 纯函数层已实现（10 tests 通过）；与 opencode LSP launch.ts 的预热管线桥接尚未完成 |
| Cross-review council 接入 prompt.ts session loop | cross-review-bridge.ts 已接入 prompt.ts supervisor 决策循环；checkCrossReviewTrigger() 在 skill 激活后调用 |

### ✅ 已修复 P0 (本轮 + 历史)

| P0 项 | 状态 | 说明 |
|---|---|---|
| `export namespace` → flat exports 重构 | ✅ 已修复 | 9 个文件的 `export * as X from "./x"` self-reexport 均已移除，改为 flat named exports |
| `triggers.ts` 自引用 false positive | ✅ 已修复 | 修复 read 工具输出误判为 error；增强 stripSelfInjections 过滤 reviewer output JSON |
| `updateState` 中 `repeatedToolFailure: false` 硬编码 | ✅ 已修复 | 验证数据流正确传递；添加 6 个回归测试 |
| Doctor session state false positive | ✅ 已修复 | cooldown fingerprint key `task-signal` → `sk-` 碰撞已通过 JSON-aware 扫描解决；session state 写入前统一 redact() |
| Gate/reconciliation 循环 | ✅ 已修复 | `GATE_MAX_RETRIES=2` + `gate_block_retries` 追踪；两条 prompt gate 路径均接入 hard-stop summary，同一 block reason 超限后不再继续普通 hint 循环 |
| **Gate synthetic_hint 未注入到消息流 (CRITICAL)** | ✅ 本轮修复 | `gatePendingHints` 队列将 gate block 的 synthetic_hint 作为 synthetic text part 注入到 conversation |
| **第二 gate 路径缺少 synthetic_hint merge** | ✅ 本轮修复 | reconciliation gate 的 synthetic_hint 与 evidence gate hint 合并注入 |
| **Role-cross 缺少 JSON 输出模板** | ✅ 本轮修复 | role-cross reviewer prompt 包含 `emptyReviewerOutput` JSON 模板 |
| **Hardcoded 用户路径** | ✅ 本轮修复 | skill-registry.ts 中 /Users/dailulu 绝对路径改为 $HOME 和相对路径 |
| **Dead .replace() call** | ✅ 本轮修复 | supervisor.ts line 792 移除无效的 `.replace()` 调用 |
| realToolEvidence 识别 | ✅ 已修复 | 新增 `python3 -m py_compile` / `git diff --check` / `dll-agent doctor` / `result:(ok|warn)` 匹配 |
| Skill activation 重复证据 | ✅ 已修复 | 同一 skill + 同一 fingerprint 不再重复写入 evidence |
| Finalization 上下文压缩 | ✅ 已修复 | `buildFinalReportContext()` 只传目标/reviever/验证/block 摘要 |
| Usage/Quota/Cost 显示与刷新 | ✅ 已修复 | 区分 local est. / provider billed / provider balance；Quota TTL=300s + stale 标记 + 刷新时间显示 |
| Quota 60 秒后台刷新 | ✅ 已实现 | `dll-agent` 启动时通过单例 daemon 调用 `dll-agent-quota --loop --interval 60`；`refresh.pid` 防重复；默认最长运行 6 小时 |
| Session/Evidence 自动清理 | ✅ 已实现 | 启动时执行保守清理：保留当前 session，删除 30 天以上或超过 90 个上限的旧 session，并裁剪单 session evidence 文件数 |
| MCP 生命周期状态收敛 | ✅ 已实现 | 启动时清理 dll-agent 管理过的 dead PID 状态；`mcp-manager.ts` 支持 stale PID reconciliation 和 managed stop/cleanup |
| 自举升级闭环 | ✅ 已实现 | self-upgrade skill + MCP manager + 脚本工具箱 + 升级守卫 |
| Capability-driven runtime | ✅ 本轮实现 | `capability-orchestrator.ts` 复用 schema/registry/planner/resolver/lifecycle；`capability-action-runner.ts` 执行低风险项目内 auto_install；`prompt.ts` 将 selected capabilities 转为 skill intents、MCP requests、system summary 和 capability gate block |
| Auto-install verification + Result Ledger | ✅ 本轮实现 | `capability-action-runner.ts` 在安装成功后执行 allowlisted verify commands，并写入 `result-ledger.ts`；验证失败记为 `PARTIAL` |
| Browser audit artifact reconciliation | ✅ 本轮实现 | report/screenshot/script 可补写 Result Ledger；旧 gate block 会被清理或改写为 evidence-backed readiness block |
| Generated report secret redaction | ✅ 本轮实现 | 仅对生成报告 artifact 自动脱敏，不修改业务源码；doctor/gate 不接受含 secret 或未覆盖核心项的 verified claim |
| Browser audit artifact evidence | ✅ 本轮实现 | `node audit-full-browser.mjs` / Playwright 审计输出、`files/*audit-report.md` 与 `test-screenshots/*.png` 被识别为真实执行证据；若报告含 FAIL 或“无阻断”与 FAIL 矛盾，final gate 只能给 PARTIAL/BLOCKED |

### ❌ 尚未实现

| 特性 | 说明 |
|---|---|
| 自动安装外部服务 | 不在范围内（违反安全策略） |
| 多模型并行技能评审 | 不在范围内（cost 过高） |
| 大规模 TUI 重构 | 不在范围内 |
| 无边界自我重构 | 不在范围内（self-repair 仅做最小补丁） |

## 🍎 Mac-only Repository Slimming

日期：2026-05-08

将 opencode 完整 monorepo 裁剪为 macOS dll-agent 最小可维护仓库。

**保留包**：opencode, core, plugin, sdk/js, script（5 workspace packages）

**删除包**：desktop, web, app, enterprise, function, slack, storybook, ui, console/\*, containers, extensions, identity（13 packages/dirs）

**删除根级**：多语言 README (19 lang), root script/, nix/, sdks/vscode/, infra/, github/, flake.nix, flake.lock, SST config

**删除 patches**：solid-js, @standard-community/standard-openapi, install-korean-ime-fix.sh

**验证通过**：typecheck ✅, 310 tests pass ✅, doctor warn ✅

**详细报告**：`packages/docs/dll-agent-repository-slimming.md`

## 下一步任务

1. ~~**P0**：`export namespace` → flat exports 重构~~ ✅ 已完成 (本轮)
2. ~~**P0**：修复 `triggers.ts` 自引用 false positive~~ ✅ 已完成 (本轮)
3. ~~**P0**：修复 `updateState` 中 `repeatedToolFailure: false` 硬编码~~ ✅ 已完成
4. ~~**P0**：修复 doctor session state false positive~~ ✅ 已完成 (本轮)
5. ~~**P0-CRITICAL**：修复 gate synthetic_hint 未注入到消息流~~ ✅ 本轮修复
6. ~~**P0**：修复 role-cross JSON 输出模板缺失~~ ✅ 本轮修复
7. ~~**P0**：修复 hardcoded 用户路径~~ ✅ 本轮修复
8. ~~**P1**：permission-classifier 接入 opencode Permission.Request 管线~~ ✅ 本轮完成（permission-bridge.ts 已接入 src/permission/index.ts:18）
9. **P1**：lsp-strategy 接入 opencode LSP launch 管线（纯函数层已完成，需桥接）
10. ~~**P1**：cross-review council 接入 prompt.ts session loop~~ ✅ 本轮完成
11. ~~**P1**：continuation gate 接入 final gate path~~ ✅ 本轮完成
12. **P1**：添加 prompt.ts supervisor 集成测试
13. ~~**P2**：Evidence file rotation 自动调度~~ ✅ 启动时已接入保守 session/evidence cleanup；当前 session 不清理
14. **P2**：Supervisor Effect.sync() 包装，确保 Effect fiber 模型兼容
14. ~~**P1**：tool-prompt 接入 system prompt~~ ✅ 本轮完成（buildPromptIndex() 已注入 system 数组）
15. ~~**P1**：actionable-error 接入 gate block 路径~~ ✅ 本轮完成（buildActionableError() 注入 gate block hint）
16. ~~**P1**：tool-prompt project overlay 加载~~ ✅ 本轮完成（loadProjectOverlay + buildEffectiveManifest 替换 buildGlobalEffective）
17. ~~**P2**：ux-state TUI 接入~~ ✅ 本轮完成（buildCompactSummary 驱动 uxLine）
18. ~~**P1**：Capability runtime 接入 session loop~~ ✅ 本轮完成（orchestrator + MCP.Service.add + skill intents + capability gate）
19. ~~**P1**：Capability action runner 执行低风险项目内安装~~ ✅ 本轮完成（argv runner + allowlist + project cwd + timeout；高风险/全局安装阻断）
20. ~~**P1**：MCP healthUrl HTTP probe~~ ✅ 本轮完成（local-only probe；remote skipped）
21. ~~**P1**：/capability-status 直接 runtime renderer~~ ✅ 本轮完成（Command layer 直接调用 renderCapabilityStatus）
22. ~~**P1**：auto-install verify command 写入 Result Ledger~~ ✅ 本轮完成（VERIFIED_COMPLETE / PARTIAL 区分）
23. ~~**P2**：TUI sidebar 消费 capability-status~~ ✅ 本轮完成（`sidebar/capability.tsx` 调用 `buildCapabilitySidebarStatus()`，有限行数 + 自适应刷新；已修复全 registry permission 误报为当前阻塞的问题）

## 验证状态

| 验证 | 命令 | 结果 |
|---|---|---|
| TypeScript typecheck | `bun run --cwd packages/opencode typecheck` | ✅ tsgo --noEmit: 0 errors |
| Unit tests | `bun test test/dll-agent/` | ✅ 327 pass, 0 fail (18 files) |
| Tool system tests | `bun test test/dll-agent/tools.test.ts` | ✅ 58 pass, 0 fail |
| Wrapper syntax | `python3 -m py_compile dll-agent dll-agent-quota` | ✅ OK |
| Doctor | `dll-agent doctor` | ✅ result: warn (only expected API-key-in-memory warning) |
| Git whitespace | `git diff --check` | ✅ clean |
| Global manifest | `~/.dll-agent/global/tools.jsonc` | ✅ 12 tools registered 
