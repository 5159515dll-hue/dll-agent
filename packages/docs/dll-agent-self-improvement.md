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

### context-handoff-packet.ts
ContextHandoffPacket v1：dll-agent 多模型之间的结构化信息交接协议。它不是新增角色，也不增加 reviewer 调用频率；它把 reviewer context 从自由压缩文本升级为“结构化 packet → role-specific renderer → `<compact-review-context>`”。
- `user_goal` 优先来自 Goal Contract，没有 Goal Contract 才 fallback 到最近真实 user message。
- 强制聚合 success criteria、active plan、verification summary、blocking findings、required actions、Result Ledger packet refs、evidence refs。
- 缺失字段写入 `missing_context`，并降低 `context_confidence`，避免模型误以为上下文充分。
- renderer 对 requirements-inspector、chief-engineer、long-context-archivist、task-completion-archivist、final-auditor、role-cross、multimodal-context-interpreter 做角色化压缩，默认仍限制在 5000 chars。
- packet summary 写入 `context_handoff.packet_built` evidence，便于后续追踪 reviewer 输入质量。
- reviewer result 记录 `context_packet_id`；缺失时显式标记 `missing_context_packet`，final/reconciliation gate 可感知该审计风险。
**状态**: implemented_runtime_verified（ContextHandoffPacket v1）。

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

### permission-mode.ts
三档权限模式，提供 `/permissions` 本地命令和 TUI command palette 入口。
- `default`: 回到 OpenCode 默认权限流。
- `auto-review`: 使用 dll-agent risk-based precheck，低风险/项目内普通操作自动允许，高风险或不确定操作继续请求确认。
- `full-access`: 用户显式授予全部权限；高风险、reviewer 写入、secrets、push、sudo 等请求会被允许，但写入 `permission.full_access_override` evidence，不伪装成安全模式。
- 选择写入 `~/.dll-agent/config/permissions.json`，可被 `DLL_AGENT_PERMISSION_MODE` 或 legacy `DLL_AGENT_AUTO_ALLOW` 覆盖。
- Full Access 不再写入静态 agent allow-all ruleset，而是在 `permissionPreCheck()` 动态生效，因此 `/permissions default` 可无需重启恢复 OpenCode 默认权限流。
**状态**: implemented_runtime_verified。

### lsp-strategy.ts (NEW — Phase 2)
LSP 预热策略：检测项目主语言，只预热主语言 LSP，辅助语言 LSP 保持 lazy。
- 支持三种模式：lazy / project-main / all-detected
- 自动排除 node_modules、.git、dist、.venv 等目录
- 预热最多读取 N 个代表性源码文件，不扫描全仓库
- Phase 7.3 已接入 `prompt.ts`：top-level dll-agent session 会 best-effort 预热主语言少量文件；辅助语言仍通过 read/edit/lsp tool lazy activation。
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
- `checkResultSufficiency()` 会把缺 evidence refs 或缺 passed verification 的 `VERIFIED_COMPLETE` 映射为 `blocked_missing_evidence` / `verify_existing`，不能直接复用为最终完成证据。
- `files_changed[].hashAfter` 会和当前文件 bytes 做 sha256 对比；没有 hash 时用 `mtimeMsAfter + sizeAfter` fallback；hash/stat 变化或文件删除时 verdict 为 `stale`，写入 `result.stale_detected` evidence。
- `buildDedupDispatchDecision()` 将 `reuse_existing` 转换为 dispatch hard skip；reviewer dispatch 已跳过重复 reviewer，commander final claim 必须明确复用已有 packet 或给出 redo justification。
- `recovery-loop.ts` 在恢复前查询 Result Ledger；已有 verified non-stale packet 时生成 `reuse_existing_result`，避免重复修复。
- `finalGate()` 要求匹配的 `VERIFIED_COMPLETE` ResultPacket；stale、missing evidence、partial/failed/blocking、低置信 fallback reviewer output 都会阻断 PASS；自然语言 summary 不能替代 Result Ledger。
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
- 每次 commander/reviewer/subtask/fallback/skipped reviewer 都写 `model.routing_decision` evidence，包含 action、correctness_reason、cost_reason、result_refs、structured skipped reviewer details。
- correctness-required reviewer 如果因为预算、cooldown 或 provider 不可用被跳过，会写 `unresolved_routing_risk`；final gate 会读取该 evidence 并阻断静默 PASS。
- verified non-stale Result Ledger packet 会跳过重复 reviewer；stale/partial/failed/missing-evidence result 不会被当成已完成。
- high-risk task signal 已覆盖 provider/routing/gate/evidence/result-ledger/permission/model switching/doctor/quota/cost/MCP runtime/secrets/destructive 操作。
**状态**: implemented_runtime_verified（Phase 5 最小闭环）。低层 tool-event bus、跨 session routing memory、独立 routing dashboard 仍未实现。

### Cross-review / Role-cross Council (Phase 5)
最小 cross-review council：只在 repeated failure、reviewer conflict、final/gate disagreement、高风险缺证据或 recovery exhausted 时触发，不用于普通低风险任务。
- Council packet 包含 issue、participants、competing findings、Result Ledger snapshot、evidence refs、arbitration/recommended solution/required verification/commander action required。
- role-cross 只做仲裁，不直接写代码；commander 必须 reconciliation 后才能 final PASS。
- reviewer fallback prose 会被 Reviewer Output Normalization 转为 low-confidence ResultPacket，gate 可见但不能当 verified evidence。
- 缺 context_packet_id 或 correctness-required skip risk 会被 final/reconciliation gate 看到。
**状态**: implemented_runtime_verified（Phase 5 最小闭环）。独立 council runtime 与 cross-session council history 未实现。

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
| Permission modes | `permission-mode.ts` + `/permissions` + TUI command palette | 三档模式：Default 使用 OpenCode 默认权限流；Auto-review 自动放行低风险/commander 项目内普通写入并询问高风险；Full Access 为用户显式全权限模式，放行所有权限并写 override evidence |
| Risk-based permission precheck | `permission-bridge.ts` + `permission-classifier.ts` + `role-tool-policy.ts` | Auto-review 模式下高风险 push/sudo/secrets/destructive 仍 ask；Full Access 模式下不做安全拦截，只记录显式 override |
| MCP 管理器 | `mcp-manager.ts` | 配置驱动声明、按需启动、互斥锁、healthcheck、degrade/cooldown |
| MCP 管理桥接 | `mcp-manager.ts:fromCatalogRegistration()` | 桥接 tool-catalog → mcp-manager，提供 McpRegistration 类型 |
| 脚本工具箱 | `toolbox.ts` | 9 个内置脚本（typecheck/test/python/doctor/git-diff/quota/smoke），+ tools/MCP doctor 检查 |
| 升级守卫 | `upgrade-guard.ts` | 升级前 smoke、失败自动回滚指令、upgrade evidence 写入 |
| 全局工具目录 | `tool-catalog.ts` | 12 个默认工具/MCP 声明（doc/docx, pdf, ppt/pptx, xlsx, github, playwright, engineering-test, observability, repo-doctor, security-redaction, docs-sync, test-gate）；含 start_policy / injection_policy / heavy 标记 |
| 项目工具叠加 | `tool-overlay.ts` | project overlay 加载、global+project merge、effective manifest 写入 session state + evidence |
| 最小 prompt 注入 | `tool-prompt.ts` | prompt index（≤1200 chars）+ on-demand 按需加载详细说明（≤1500/tool, ≤3000/round） |
| 工具 slash 命令 | cleaned | prompt-only /tools 与 /mcp-* 管理命令已移除；保留 runtime-backed /capability-status |
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

### Phase 10 Real-World Scenario Evaluation 状态

当前全局状态：`GLOBAL-PASS` for required live/manual scenarios。Optional Playwright MCP isolated start/stop 仍为 `optional_not_run`，不计入 required gate。

`PHASE-PASS` 只适用于 deterministic/local evaluation。manual/live 场景仍明确为 not run，不能写成 passed。

| 能力 | 状态 | 说明 |
|---|---|---|
| 20 个真实任务验收场景 | implemented_runtime_verified | `scenario-evaluation.ts` 固化普通短任务、用户纠偏、测试失败、typecheck 失败、repeated failure、final evidence 缺失、未完成计划、result reuse/stale、高风险 provider/routing、权限/secrets、MiMo 多模态、MiMo fallback、role-model-set、doctor failed、doctor --repair-safe、final report、普通问题自动推进、必须用户介入、reviewer conflict 等 20 个场景 |
| 场景输出字段完整性 | implemented_runtime_verified | 每个场景记录 goal、expected route、model roles used、evidence、final status、human intervention、cost/token tier、evaluation layer、external status、acceptance refs |
| false PASS 防护 | implemented_runtime_verified | `evaluateRealWorldScenarioSuite()` 检查 VERIFIED_COMPLETE 必须有 evidence 和 gate；final evidence 缺失场景不能是 VERIFIED_COMPLETE |
| 正确性优先路由验收 | implemented_runtime_verified | 用户纠偏必须 requirements-inspector；repeated failure 必须 chief-engineer/role-cross；reviewer conflict 必须 role-cross；高风险 provider/routing 允许多 reviewer |
| 普通任务成本守卫验收 | implemented_runtime_verified | 普通短代码任务只使用 commander，不触发 reviewer；MiMo-V2.5 不进入纯文本 fallback 场景 |
| Doctor 集成 | implemented_runtime_verified | `dll-doctor.ts` 增加 `real-world-scenario-evaluation` 检查；deterministic/local 场景 fail 或 false_pass_risk > 0 时 doctor failed；manual/live-only not_run 不被误写为 passed |
| Required live/manual scenario execution | implemented_runtime_verified | Phase 10.2 已完成 S1 role-model-set no-tool live、secrets/permission fixture、destructive command fixture、recovery fixture、continuation fixture、MiMo multimodal live 和 doctor repair-safe cleanup；Playwright MCP isolated start/stop 是 optional_not_run |

### RC 能力状态矩阵

| 能力 | 状态 | RC 说明 |
|---|---|---|
| Goal Contract | implemented_runtime_verified | runtime 创建、读取、refine、evidence、final/continuation gate 接入已测 |
| Task State | implemented_runtime_verified | task status 聚合 goal、plan、verification、doctor、ledger 状态已测 |
| Continuation Gate | implemented_runtime_verified | blocking unfinished 阻断 PASS，生成 continuation packet |
| Final Gate | implemented_runtime_verified | 读取 Goal Contract、Result Ledger、reviewer、doctor、routing risk |
| Autonomous Recovery | implemented_runtime_verified | 普通错误分类、budget、升级、blocked report 已测 |
| Result Ledger | implemented_runtime_verified | ResultPacket 写入/查询/复用/红线状态已测 |
| Dedup Hard-block | implemented_runtime_verified | reviewer/final/continuation/recovery dispatch 层 hard-block 已测 |
| Stale Detection | implemented_runtime_verified | file hash、delete、mtime fallback 已测 |
| Correctness-Aware Routing | implemented_runtime_verified | 用户纠偏、repeated failure、高风险、final evidence 缺失路径已测 |
| Routing Evidence | implemented_runtime_verified | correctness_reason、cost_reason、skip risk、fallback refs 已测 |
| Multi-model reviewer | implemented_runtime_verified | requirements-inspector、chief-engineer、task-completion、final-auditor、role-cross 最小闭环已测 |
| ContextHandoffPacket | implemented_runtime_verified | reviewer/subtask/Kimi/role-cross 上下文 packet 与 renderer 已测 |
| Reviewer Output Normalization | implemented_runtime_verified | structured 与 fallback ResultPacket 均 gate 可见 |
| Role Provider Bridge | implemented_runtime_verified | role model 经 provider 校验、fallback、metadata snapshot 已测 |
| Role Model Registry | implemented_runtime_verified | session/project/global override、fallback、doctor check 已测 |
| MiMo Provider Status | implemented_runtime_verified | status/quota unavailable/no endpoint 可见；Phase 10.2 用安全合成截图完成 `mimo-v2.5` live multimodal packet 验证 |
| Permissions / Role Tool Policy | implemented_runtime_verified | Default/Auto-review/Full Access、只读 reviewer、高风险边界已测 |
| Doctor repair-safe dry-run | implemented_runtime_verified | dry-run 不删除 active session、不碰 secrets、不 kill process |
| Capability Registry | implemented_runtime_verified | built-in/global/project/session merge、denylist、prompt index、doctor 已测 |
| MCP runtime | implemented_runtime_verified | on-demand、mutex、healthcheck、stop、no auto-start 已测 |
| LSP prewarm | implemented_runtime_verified | project-main prewarm + lazy activation + excluded dirs 已测 |
| multimodal-context-interpreter | implemented_runtime_verified | detection、packet、ResultPacket、redaction 已测；Phase 10.2 live MiMo screenshot packet passed |
| UX State | implemented_runtime_verified | task status、final status、doctor/result/continuation visibility 已测 |
| Observability | implemented_runtime_verified | trajectory、model usage、routing report、doctor next action、scenario status 已测 |
| Regression scenarios | implemented_runtime_verified | 20/20 deterministic/local pass；Phase 10.2 required live/manual 场景已通过；optional Playwright MCP isolated start/stop 仍 optional_not_run |
| Architecture modularization | partial_runtime | Role Provider Bridge、Session Runtime Adapter、Supervisor decomposition 小切片已完成；包路径/部分 supervisor 历史结构仍保留 |

RC 额外边界：

| 场景 | 状态 | 说明 |
|---|---|---|
| Manual secrets/permission scenario | manual_passed | Phase 10.2 使用 fixture/dry-run 验证 Auto-review ask/block、Full Access override evidence、无 secret value 输出 |
| Manual destructive command scenario | manual_passed | Phase 10.2 使用 fixture/dry-run 验证 rm/git push/sudo 等高风险操作不会 silent auto allow，未执行真实破坏性命令 |
| Live multimodal screenshot scenario | live_passed | Phase 10.2 用安全合成截图和 `mimo-v2.5` 生成 `multimodal_context_packet`；不触发 TTS/VoiceClone/MCP/coding loop |
| Optional Playwright MCP isolated start/stop | optional_not_run | 需要显式授权启动外部进程；不是 required GLOBAL gate |

### Phase 4 Result Ledger / Dedup / Stale 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| ResultPacket write/query | implemented_runtime_verified | `writeResult()` / `queryResults()` 维护 session-scoped JSONL；`reusable_only` 排除 stale/invalidated packet |
| Result Sufficiency Gate | implemented_runtime_verified | `checkResultSufficiency()` 区分 reuse、verify、continue、repair、blocked_missing_evidence、blocked_stale、no_existing_result |
| missing evidence cannot reuse | implemented_runtime_verified | `VERIFIED_COMPLETE` 缺 `evidence_refs` 或 passed verification 会映射为 `blocked_missing_evidence`，不能作为 final evidence |
| file hash / mtime stale detection | implemented_runtime_verified | `files_changed[].hashAfter` 与当前文件 sha256 不一致、文件删除，或 mtime/size fallback 变化时 verdict=`stale` |
| reviewer dedup hard-block | implemented_runtime_verified | `supervisor.generateSubtasks()` 发现 reusable verified reviewer result 时不再派发 reviewer，并写 routing/evidence |
| commander duplicate completion guard | implemented_runtime_verified | `prompt.ts` final loop 要求 commander 明确复用已有 packet 或说明 redo reason |
| Final Gate reads Result Ledger | implemented_runtime_verified | final PASS 会读取 Result Ledger，阻断 stale、partial、failed、missing evidence、低置信 fallback 和缺 matching verified result |
| Recovery Loop consumes Result Ledger | implemented_runtime_verified | `planRecovery()` 可根据 existing verified packet 复用结果，或对 unverified packet 只跑 verification |
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

### Phase 6 Permissions / Role Tool Policy / Safety 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| permission modes | implemented_runtime_verified | `/permissions [default|auto-review|full-access]` 本地命令 + TUI 入口；选择写入全局配置；permissionPreCheck 动态读取，无需重启 |
| risk-based permission precheck | implemented_runtime_verified | `Permission.ask()` 进入 ruleset 前调用 `permissionPreCheck()`；Default 透传 OpenCode，Auto-review 风险分级，Full Access 动态放行 |
| reviewer read-only policy | implemented_runtime_verified | requirements-inspector、long-context-archivist、task-completion-archivist、final-auditor、role-cross、multimodal-context-interpreter deny mutating tools |
| commander/chief/executor writable | implemented_runtime_verified | writable roles 允许项目内普通 file write/edit；未知 shell command 仍 ask |
| high-risk confirmation | implemented_runtime_verified | Auto-review 模式下 `git push`、`sudo`、`rm -rf`、secret file access 仍 ask；Full Access 按用户显式选择全部放行，并写 `permission.full_access_override` |
| permission evidence | implemented_runtime_verified | role/tool decisions 写 `role_tool_policy.decision` evidence，不记录 secrets 内容 |
| doctor role-tool-policy check | implemented_runtime_verified | `dll-doctor.ts` 调用 `doctorCheckRoleToolPolicy()`，doctor warn/failed 不伪装 |
| doctor --repair-safe wrapper入口 | implemented_runtime_verified | `/Users/dailulu/.local/bin/dll-agent doctor --repair-safe` 只调用 inactive session/evidence cleanup 和 managed MCP state reconciliation；不碰 secrets，不 push，不做系统级修改 |
| doctor --repair-safe dry-run | implemented_runtime_verified | `/Users/dailulu/.local/bin/dll-agent doctor --repair-safe --dry-run` 只读报告 evidence session pressure、inactive cleanup candidates、MCP candidates 和 quota stale；不删除、不 kill、不碰 secrets |
| full sandbox isolation | missing | 仍依赖 OpenCode tool permission + local policy；未引入 OS-level sandbox |

### Phase 7 Tools / Skills / MCP / LSP / Multimodal 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| capability-driven runtime | implemented_runtime_verified | `prompt.ts` 调用 `orchestrateCapabilities()`，在 `resolveTools()` 前规划 selected tools / skills / MCP requests / system summary |
| Phase 7.1 Capability Registry + Manifest | implemented_runtime_verified | `capability-schema.ts` 覆盖 skill/tool/MCP/LSP/multimodal；`capability-registry.ts` 支持 built-in/global/discovered/project/session merge 与 effective status；doctor 检查 heavy MCP/GitHub/multimodal/prompt index |
| heavy MCP manifest guard | implemented_runtime_verified | Playwright/GitHub 等在 manifest/doctor 层保持 registered/on_demand/not running；本轮不改已有 prompt runtime auto-connect 策略 |
| prompt capability index | implemented_runtime_verified | `buildCapabilityPromptIndex()` 只注入短 id/kind/status index，避免完整工具说明进入 prompt |
| low-risk tool auto-upgrade | implemented_runtime_verified | 文档类 Python tools 声明真实 package，`capability-resolver.ts` 生成项目内 `.dll-agent/tools/python` target install，不再错误尝试安装 `python3` binary |
| auto-install verification | implemented_runtime_verified | `capability-action-runner.ts` 使用 allowlisted argv 执行 install + verify，verify 子进程带 project-local `PYTHONPATH` |
| auto-upgrade result reuse | implemented_runtime_verified | 已验证 capability install 写入 Result Ledger；同一 session 再次需要同一 capability 时复用 `VERIFIED_COMPLETE` packet，不重复安装/提示 |
| high-risk install guard | implemented_runtime_verified | `brew`、global npm、无 project-local `--target` 的 pip、high-risk capability 仍 blocked/ask，不因 auto-upgrade 绕过权限 |
| on-demand MCP planning | implemented_runtime_verified | registry trigger 选中 MCP 后通过 `MCP.Service.add()` 接入；credential/login/destructive/remote risk 会阻断 auto connect |
| LSP project-main prewarm + lazy activation | implemented_runtime_verified | `lsp-bridge.ts` 生成 bounded targets，`prompt.ts` best-effort 调用 `LSP.Service.hasClients/touchFile`；只预热主语言，辅助语言保持 lazy；doctor/status/evidence 可见 |
| multimodal routing guard | implemented_runtime_verified | 纯文本/代码任务不触发 `multimodal-context-interpreter`；非文本输入才触发 MiMo 多模态路径 |
| multimodal context packet runtime | implemented_runtime_verified | `reviewer-result-bridge.ts` 对 `multimodal-context-interpreter` raw output 优先解析 `multimodal_context_packet`，保存 packet、写 evidence 和 Result Ledger；非结构化输出只作为 low-confidence fallback，不替代测试/doctor/typecheck/final verification |
| TTS/VoiceClone exclusion | implemented_runtime_verified | voice/TTS model guard 禁止进入 coding role；MiMo-V2.5 仅用于多模态理解 |
| full third-party tool marketplace | missing | 本轮不引入 skill 市场或第三方依赖安装系统 |

### Phase 8 UX / Doctor / Observability 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| task status command | implemented_runtime_verified | `/task-status` 由 session runtime 本地处理，调用 `renderTaskStatus()`，不发起 LLM 调用 |
| task trajectory / flight recorder | implemented_runtime_verified | `task-observability.ts` 聚合 Goal Contract、Supervisor、Result Ledger、evidence 和 routing decision，输出 bounded trajectory |
| final status visibility | implemented_runtime_verified | `/task-status` 显示 `VERIFIED_COMPLETE` / `CONTINUATION_REQUIRED` / `BLOCKED_USER_REQUIRED` / `BLOCKED_BUDGET_EXHAUSTED` / `UNVERIFIED_PARTIAL` / `FAILED` / `UNKNOWN`，仅来自已有 runtime/evidence |
| verification / doctor visibility | implemented_runtime_verified | 显示 required verification、passed/failed/not_run/unknown 计数和最新 `doctor.run` evidence 状态；不会主动运行 doctor |
| continuation visibility | implemented_runtime_verified | 显示 last continuation packet、continuation count、blocking unfinished、requires user input、budget exhausted 状态 |
| routing report visibility | implemented_runtime_verified | task status 汇总 `model.routing_decision` 的 selected models 与 skipped reviewers |
| Result Ledger visibility | implemented_runtime_verified | task status 显示 total/verified/partial/failed/blocked/unverified/stale/reusable/missing-evidence/low-confidence，并把 unresolved items 作为 blockers/next actions |
| TUI status visibility | implemented_runtime_verified | session panel 复用只读 observability report，显示 task/final status、verification/doctor 和 ledger/continuation 短线；不改变颜色主题或布局语义 |
| doctor observability check | implemented_runtime_verified | `dll-doctor.ts` 增加 `task-observability` 自检，失败时给出 inspect next action |
| doctor safe cleanup next action | implemented_runtime_verified | evidence session 超阈值时 doctor 明确建议 `dll-agent doctor --repair-safe` |
| task trajectory command | implemented_runtime_verified | `/task-trajectory` 读取 evidence / Result Ledger，输出脱敏 flight recorder，不触发模型 |
| model usage / routing report | implemented_runtime_verified | `/model-usage` 和 `/routing-report` 读取 `model.routing_decision`，显示 correctness/cost reason、skip reason 和 unresolved risk |
| doctor next action | implemented_runtime_verified | `/doctor-next` 将 doctor warn/fail 映射为 no action / optional / authorization required / blocking，不执行 repair |
| regression scenario tracker | implemented_runtime_verified | `/regression-status` 暴露 20 个验收场景的 `not_run` 状态；不把 registry 当成真实通过 |
| TUI visual redesign | implemented_runtime_verified | session panel 已重排为 global status、task overview、model/capability summary、command activity mini window；仅消费只读 adapter，不改变业务状态 |
| persistent regression run history | partial_runtime | 20 场景 registry/status 已实现；真实场景执行历史仍需后续记录 |

### TUI Layout Refresh 状态

| Capability | Status | Notes |
|---|---|---|
| Global status bar | implemented_runtime_verified | 顶部显示项目/session、final/task status、commander model/source、active role、doctor、cost/quota |
| Task overview | implemented_runtime_verified | 显示 goal、phase/risk、plan blockers、next action、verification、Result Ledger 和 continuation 摘要 |
| Model/capability summary | implemented_runtime_verified | 读取 role-provider snapshot 与 capability-status；显示 reviewer/routing、tools/skills/MCP/software、running/on-demand/blocked |
| Command activity mini window | implemented_runtime_verified | `command-activity.ts` 从 evidence 和 Result Ledger command refs 构建脱敏只读 command/tool 摘要 |
| Command expanded view | implemented_runtime_verified | 鼠标点击展开，Esc 收起，上下键滚动；不执行命令、不触发模型、不启动 MCP |
| Terminal theme respect | implemented_runtime_verified | dll-agent panel 不设置固定 foreground/background；保持终端默认主题和少量文本强调 |
| Chinese default labels | implemented_runtime_verified | dll-agent 自有标签默认中文；role/model/provider/evidence refs 保留原值以匹配真实 runtime |
| Idle chat display guard | implemented_runtime_verified | 无 Goal Contract、verification、Result Ledger、reviewer、continuation、blocker 时显示“待命/普通对话/计划未建立”，不把闲聊显示成 UNVERIFIED_PARTIAL |
| UI business side effects | unchanged_runtime_verified | 本切片不改 Provider/RoleModel、routing、gate、recovery、permission、Result Ledger、MCP/LSP/multimodal、Capability Acquisition 语义 |

### Phase 9 Architecture Modularization 状态

| 能力 | 状态 | 说明 |
|---|---|---|
| session adapter extraction | implemented_runtime_verified | `session-adapter.ts` 统一构造 dll-agent local command 的 MessageV2 user/assistant/part 记录 |
| prompt.ts local command simplification | implemented_runtime_verified | `prompt.ts` 不再手写 `/role-models`、`/role-model-set`、`/task-status` 响应消息结构，只负责 provider 校验、session 写入和 event publish |
| local command no-LLM invariant | implemented_runtime_verified | local status/model commands 仍通过 zero-cost assistant message 返回，不调用 LLM |
| role/provider boundary unchanged | implemented_runtime_verified | RoleModel resolver 和 Provider validation 调用路径未改变；`session-adapter.ts` 不解析 provider/model |
| session command adapter | implemented_runtime_verified | `session-command-adapter.ts` 集中处理 `/task-status`、`/task-trajectory`、`/model-usage`、`/routing-report`、`/doctor-next`、`/regression-status`、`/permissions` 的本地渲染 |
| TUI status adapter | implemented_runtime_verified | `tui-status-adapter.ts` 抽出面板纯状态行、quota/cost/supervisor/observability 读取；Solid 组件只保留布局和刷新 |
| doctor observability checks extraction | implemented_runtime_verified | `doctor-checks.ts` 承接 observability/scenario doctor checks；`dll-doctor.ts` 继续保留 public `runDoctor()` / `formatDoctorReport()` |
| Role Provider Bridge | implemented_runtime_verified | `role-provider-bridge.ts` 统一 Role Model Registry -> Provider.Service.getModel -> fallback/default -> runtime model snapshot；`role-model-runtime.ts` 保持兼容 wrapper |
| gate/supervisor large split | partial_runtime | 本 Phase 未继续拆 supervisor/gates，避免一次性大迁移；保留后续可回滚小切片 |
| prompt.ts full cleanup | partial_runtime | 本 Phase 只减少 local command coupling；capability/recovery/gate orchestration 仍在 prompt loop 中 |

### Phase 9.1 Architecture Modularization 后续切片状态

| 能力 | 状态 | 说明 |
|---|---|---|
| gate composition extraction | implemented_runtime_verified | `session-gate-orchestrator.ts` 统一处理 dedup/capability/reconciliation block reason 和 synthetic hint 合并，减少 `prompt.ts` 两条 finalization path 的重复逻辑 |
| reviewer dispatch planning | implemented_runtime_verified | `reviewer-dispatch.ts` 将 supervisor subtask drain 和 read-only parallel / write-capable serial 分组规则提取为纯函数 |
| reviewer result bridge | implemented_runtime_verified | `reviewer-result-bridge.ts` 负责 structured reviewer output -> Result Ledger packet 的转换和 best-effort 写入 |
| prompt.ts orchestration shrink | implemented_runtime_verified | `prompt.ts` 行数从 3029 降至约 2950；仍保留 Effect runtime orchestration，不改变行为 |
| supervisor result wiring shrink | implemented_runtime_verified | `supervisor.ts` 行数从 1207 降至约 1182；reviewer completion 状态更新仍留在 supervisor，Result Ledger 转换移出 |
| TUI / Provider / RoleModel / routing behavior | unchanged_runtime_verified | 本切片不改 TUI、Provider、RoleModel、routing 策略或模型默认值 |
| session runtime adapter | implemented_runtime_verified | `session-runtime-adapter.ts` 将 continuation gate 结果转换为结构化 runtime actions；`prompt.ts` 只执行 state/evidence/hint/subtask 等 OpenCode session side effects |
| full prompt.ts decomposition | partial_runtime | capability action execution、MCP connect、recovery loop 注入和 subtask execution 仍在 prompt loop 中，后续应继续按小切片提取 |
| supervisor trigger rules | implemented_runtime_verified | `supervisor-trigger-rules.ts` 提取 reviewer 触发顺序和 auto-verifier 条件；`supervisor.ts` 仍负责 cooldown、routing evidence 和状态副作用 |
| supervisor state machine | implemented_runtime_verified | `supervisor-state-machine.ts` 提取 state normalization、decision application、reviewer completion 和 block-clear 逻辑；行为由单元测试保护 |
| supervisor prompt template extraction | implemented_runtime_verified | `reviewer-prompt-templates.ts` 提取 reviewer prompt 和 JSON 模板；`buildSubtask()` 仍负责 role/provider、ContextHandoffPacket、role-run envelope 和 SubtaskPart 接线 |
| supervisor dispatch/result wiring | partial_runtime | reviewer dispatch、context packet 写入、role-run envelope 和 result completion side effects 仍在 supervisor.ts，后续可继续小切片拆分 |

### ⚠️ 只是配置层实现（需要环境变量）

| 特性 | 说明 |
|---|---|
| Quality mode (max/auto/balanced/economy) | 通过 `DLL_AGENT_QUALITY` 环境变量配置 |
| Verify mode (strict/normal/light) | 通过 `DLL_AGENT_VERIFY` 环境变量配置 |
| Permission mode 开关 | `/permissions`、TUI command palette、`DLL_AGENT_PERMISSION_MODE`；legacy `DLL_AGENT_AUTO_ALLOW=0/1` 仍映射到 default/full-access |
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
| LSP strategy 接入 LSP launch pipeline | 已实现最小 runtime 闭环：`runLspPrewarmRuntime()` 在 session loop 中触发主语言 prewarm，跳过 unavailable server，不安装 language server |
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
| Multi-model role-run envelope | ✅ 本轮实现 | reviewer dispatch 写入 `role_run_id` / `role_instance_id` / `action_fingerprint`；Result Ledger 和 final gate 可追踪同模型多角色隔离风险 |
| Same-provider model identity | ✅ 本轮实现 | usage/status 展示与隔离检查使用完整 `provider/model` identity，避免同厂商不同模型被折叠成一个模型 |
| Council review protocol validation | ✅ 本轮实现 | cross-review 可检测共享 packet 缺失、reviewer 污染、context 不足、blocking finding 缺 evidence |
| Reviewer Output Normalization | ✅ 本轮实现 | reviewer 缺结构化 JSON 时写入 low-confidence fallback ResultPacket；final/reconciliation gate 可见，不把 prose 当 verified evidence |
| Phase 2 Completion / Continuation Gate 闭环 | ✅ 本轮实现 | 两条 prompt final exit path 均运行 continuation check；Goal Contract、Result Ledger、reviewer block、verification 和 context/evidence refs 会生成 continuation packet 并阻断 premature PASS |
| Phase 3 Autonomous Recovery Loop | ✅ 本轮实现 | 普通 tool/test/typecheck/config/provider/doctor/gate failure 会被分类、记录 fingerprint/budget、注入 repair/verification hint，并按 repeated failure 升级 chief-engineer / role-cross；secrets/destructive/budget exhaustion 输出 blocked report |
| Phase 7.2 MCP on-demand runtime | ✅ 本轮实现 | `mcp-runtime.ts` 在 OpenCode `MCP.Service.add()` 前执行 binary/env/port/permission/sensitive-context/mutex/cooldown preflight；连接、失败、healthcheck、stop 写 evidence；stop 封装复用 `stopManagedServer()` 且拒绝停止当前进程；doctor 检查 runtime state 和 stale mutex |
| Live smoke S1 trivial no-tool false positive | ✅ 本轮修复 | `/role-model-set commander ... --scope session` 后的“只回答 OK，不要执行工具。”识别为 `trivial_no_tool_task`，过滤本地 role-model command 输出，保持 commander-only，不触发 reviewer/verifier/MCP/tool；高风险、纠偏、repeated failure、final evidence 缺失、doctor failed 和 unresolved reviewer 仍不能被抑制 |
| Live smoke S0 stateless greeting false positive | ✅ 本轮修复并 live_passed | “你好 / hello / hi / 在吗 / 谢谢”等无状态短问候识别为 `stateless_greeting_task`，保持 commander-only，不触发 long-context-archivist、requirements-inspector、chief-engineer、task-completion-archivist、final-auditor、executor auto-verifier、repo-doctor、MCP 或工具；自生成 `<task_result>`、Verification Report、reviewer fallback、subtask resume、Result Ledger、routing evidence、doctor/TUI 文本不再污染 trigger metrics。Live retest session `20260510-120122-08636405` 通过；OpenCode title request 仍按上游行为生成，任务响应为单 commander call |
| Task Intake Classifier / Interaction Level Gate | ✅ 本轮实现 | 新增 `task-intake-classifier.ts`，按 user-origin input 输出 `task_kind` 与 `L0`-`L4` interaction level。`L0` 问候和 `L1` 普通问答 commander-only；`L2` 只读工程分析不默认 full governance；`L3` 代码/调试/验证接入 Goal Contract/Recovery/Verification；`L4` provider/routing/gate/evidence/permission/secrets/destructive/MCP/doctor failed 等高风险任务保留 reviewer/permission/final/evidence 严格要求 |
| Intent judgement / consensus gate | ✅ 本轮基座实现 | `intent-consensus.ts` 生成意图裁判计划：确定性高置信直接接受；低置信先由 commander 的非 OpenAI 主模型单模型判断；单模型仍低置信再收集 `/role-model-set` 生效配置中的所有不同非 OpenAI 模型做共识。OpenAI、TTS、VoiceClone、speech/audio 模型被排除；L4 安全硬规则不能被模型共识降级 |

### Stateless greeting false-positive guard

`stateless_greeting_task` 只用于真正的短问候/确认消息，例如“你好”“hello”“hi”“在吗”“谢谢”“thanks”“ok”“好的”。它不会降低 correctness-required reviewer：

- 用户纠偏、repeated failure、active blocking plan、continuation required、final claim 缺 evidence、reviewer block 未 reconciliation、doctor failed、高风险 provider/routing/gate/evidence/permission 修改、代码修改、验证请求、错误日志、secrets/permission/destructive 操作仍按原规则触发 reviewer/gate/recovery。
- repo-doctor 不再仅因 `.git` / `package.json` marker 对 stateless chat 激活；需要工程意图、doctor/test/build/typecheck 请求、运行失败或 recovery signal。
- false-positive blocked session 的安全清理方案仍是 partial：本轮未新增 `/task-clear-false-block` 命令；建议只在明确 stateless false positive 时清当前 session 的 supervisor blocked state，并保留 evidence/Result Ledger/Goal Contract。

### Task Intake Classifier

`TaskIntakeClassifier` 是 routing 前的稳定入口层。它只读取当前用户原始输入、用户附件 metadata、用户显式命令或用户明确提供的上下文；reviewer 输出、subtask 输出、verification report、doctor report、TUI/status、本地命令输出、Result Ledger summary、routing evidence summary、ContextHandoffPacket rendered text、`<task_result>`、model usage report 和 regression report 只能作为 evidence/trajectory，不能制造 user-origin routing triggers。

Interaction levels:

- `L0`: stateless greeting / no-op chat。Commander-only，0 reviewer，不建复杂 Goal Contract，不验证，不 continuation，不 final-auditor，不工具，不 MCP。
- `L1`: informational。示例：“介绍一下 dll-agent”“什么是 xxx”“explain xxx”。Commander-only 默认路径，不运行 typecheck/test/doctor，不触发 full governance stack。
- `L2`: light engineering analysis。只读分析、方案解释、代码结构说明；可读文件，但不自动写文件、不默认触发 full governance。
- `L3`: coding / debugging / verification。代码修改、错误日志、测试/typecheck/build/doctor，接入 Goal Contract、Recovery Loop、Result Ledger 和 Verification。
- `L4`: high risk。Provider/RoleModel/routing/gate/evidence/result-ledger/permission/secrets/destructive/push/release/system/global/MCP/doctor failed/high-cost provider。不能被模型分类器降级。

Policy manifests allow local extension without editing source:

- global: `~/.dll-agent/config/task-intake-policy.jsonc`
- project: `.dll-agent/task-intake-policy.jsonc`

Supported keys: `greetings`, `informational`, `light_engineering_analysis`, `coding`, `debugging`, `verification`, `planning`, `permission`, `multimodal`, `high_risk`.

Model classifier status: `implemented_runtime_verified` for low-confidence live intake. The deterministic classifier still runs first; live model classification is called only when deterministic intake is low confidence or ambiguous, and it cannot override L4 safety rules.

Intent judgement status: `implemented_runtime_verified`. Before commander execution, ambiguous user-origin input runs a single-model intent judge using the effective commander model; if that judgement is low confidence or unparsable, runtime escalates to all distinct effective `/role-model-set` models except OpenAI and voice/audio providers. The resulting classification is persisted in supervisor state, written to `intent.judgement` evidence, and consumed by supervisor routing.

## Autonomous Capability Acquisition Phase A / B1 / B2 / C / D1 / D2

Status: `implemented_runtime_verified` for Phase A design/schema/risk-classifier/doctor skeleton, Phase B1 local fixture quarantine/sandbox/rollback substrate, Phase B2 static download pipeline with local fixture HTTP, Phase C mock final-auditor policy gate, Phase D1 fixture sandbox smoke, and Phase D2 MCP metadata discovery. These phases do not install real packages, execute downloaded content, start MCP, activate capabilities, read GitHub tokens, or call a live final-auditor model.

| Capability | Status | Notes |
|---|---|---|
| R0-R4 risk model | implemented_runtime_verified | `capability-risk-classifier.ts` classifies metadata/static/executable/high-risk/hard-block capability acquisition requests with deterministic hard rules |
| acquisition manifest schema | implemented_runtime_verified | `capability-acquisition.ts` validates source, risk, permissions, activation, commands, smoke tests, and rollback |
| final-auditor packet shape | implemented_config_verified | `buildCapabilityAuditPacket()` produces structured audit input; live final-auditor integration is later-phase |
| acquisition evidence hooks | implemented_runtime_verified | `capability.*` evidence types use shared redaction path |
| doctor acquisition checks | implemented_runtime_verified | doctor reports acquisition store/directories/manifests/quarantine/sandbox/global-install guard without mutating files |
| quarantine store | implemented_runtime_verified | `capability-quarantine.ts` supports fixture candidate create/read/risk/audit/reject/delete under quarantine root |
| fixture sandbox runtime | implemented_runtime_verified | `capability-sandbox.ts` copies local fixture files and runs non-executing required-file smoke checks only |
| fixture rollback | implemented_runtime_verified | `capability-rollback.ts` requires dry-run and deletes only managed fixture quarantine/sandbox paths |
| static download pipeline | implemented_runtime_verified | `capability-download.ts` validates http(s), blocks binary/executable/oversize content, computes sha256, quarantines static text, and creates rollback dry-run; tests use local fixture HTTP when no trusted GitHub raw URL is provided |
| mock final-auditor gate | implemented_runtime_verified | `capability-audit-runtime.ts` enforces R2 pass-before-sandbox, R3 user authorization, and R4 hard-block with mock verdicts only |
| MCP metadata discovery | implemented_runtime_verified | GitHub MCP metadata is classified R3 when token/repo mutation is involved; Playwright/browser MCP is R3/on-demand; modelcontextprotocol servers are reference/community mixed and not installed |
| real download/install/start | partial_runtime | Static low-risk download path exists, but no arbitrary external URL was used this checkpoint; no real package install, MCP start, Playwright start, or capability activation |
| commands/UX | missing | `/capability-install` and related commands are not wired in Phase B1 |

Safety boundary: R2+ requires rollback before activation; R3 requires user authorization; R4 (`curl | sh`, `sudo`, global install, secrets, destructive delete, git push/release/upload, real browser profile, unknown binary) is hard-blocked by deterministic policy and cannot be auto-approved by final-auditor.

### ❌ 尚未实现

| 特性 | 说明 |
|---|---|
| 自动安装外部服务 | 不在范围内（违反安全策略） |
| 多模型并行技能评审 | 不在范围内（cost 过高） |
| 大规模 TUI 重构 | 不在范围内 |
| 无边界自我重构 | 不在范围内（self-repair 仅做最小补丁） |
| 全局低层 tool-call dedup | 尚未实现；当前只在 reviewer role-run / Result Ledger 层记录 action fingerprint |
| 独立 repair executor | 尚未实现；Phase 3 使用现有 commander/reviewer/tool loop，不引入新执行器 |

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
9. ~~**P1**：lsp-strategy 接入 opencode LSP launch 管线~~ ✅ 本轮完成（Phase 7.3：project-main prewarm + auxiliary lazy activation）
10. ~~**P1**：cross-review council 接入 prompt.ts session loop~~ ✅ 本轮完成
11. ~~**P1**：continuation gate 接入 final gate path~~ ✅ 本轮完成（Phase 2：两条 final exit path 均接入；packet 包含 missing verification / result refs / context refs / budget state）
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
20a. ~~**P1**：MCP on-demand runtime preflight~~ ✅ 本轮完成（启动前检查 role-tool-policy、missing binary/env、port、sensitive browser/profile context、mutex/cooldown；默认不启动 Playwright/GitHub MCP）
20b. ~~**P1**：LSP project-main prewarm~~ ✅ 本轮完成（只 touch 主语言代表文件；排除 node_modules/.git/.venv/dist/build 等；无 language-server 自动安装）
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
