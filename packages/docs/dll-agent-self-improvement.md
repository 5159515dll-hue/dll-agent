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
Evidence gate、reconciliation gate、final completion gate 的判定标准。所有 gate 判断基于代码，部分需要模型辅助时通过 reviewer 完成。
**代码模式**: ✅ flat exports (P0-1: 已移除 self-reexport, 改为 flat named exports)。

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
- 自动分类 14 种错误类型（typecheck_error、test_failure、permission_denied 等）
- 输出包含：what failed、why likely、next automatic action、user action if required
- 生成 failure fingerprint 用于去重
**代码模式**: ✅ flat exports。

### cross-review.ts (NEW — Phase 5)
多模型对抗交叉审查系统（Cross-Review Council）。
- 触发条件：重复失败、reviewer 冲突、高风险完成、证据不足、用户纠偏
- 结构化 council packet — 所有 reviewer 基于同一证据判断
- Reviewer 输出结构化（blocking、confidence、findings、required_verification）
- role-cross 仲裁冲突（基于 evidence，不是投票）
- council 受 cooldown 和 cost guard 限制
**代码模式**: ✅ flat exports。

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
