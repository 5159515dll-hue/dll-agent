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
内置技能声明（纯数据，无副作用）。定义 8 个技能及其完整约束。
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
| MCP runtime 全链路接入 | tool-catalog/tool-overlay 纯函数层已实现；与 opencode MCP Effect layer 的全链路桥接（自动 markRunning/markStopped/degrade）尚未接入 src/mcp/index.ts |
| MCP healthcheck HTTP probe | mcp-manager.ts healthcheck() 目前仅检查进程存活；healthUrl 配置的 HTTP probe 尚未实现 |
| on-demand MCP auto-start | 在 opencode session 中根据 context 自动判断是否需要启动 MCP 的集成尚未完成 |
| TUI quota 显示组件 | 已实现 dll-agent-panel.tsx，但需验证 |

### ✅ 已修复 P0

| P0 项 | 状态 | 说明 |
|---|---|---|
| `export namespace` → flat exports 重构 | ✅ 已修复 | 9 个文件的 `export * as X from "./x"` self-reexport 均已移除，改为 flat named exports |
| `triggers.ts` 自引用 false positive | ✅ 已修复 | 修复 read 工具输出误判为 error；增强 stripSelfInjections 过滤 reviewer output JSON |
| `updateState` 中 `repeatedToolFailure: false` 硬编码 | ✅ 已修复 | 验证数据流正确传递；添加 6 个回归测试 |
| Doctor session state false positive | ✅ 已修复 | cooldown fingerprint key `task-signal` → `sk-` 碰撞已通过 JSON-aware 扫描解决；session state 写入前统一 redact() |
| Gate/reconciliation 循环 | ✅ 已修复 | `GATE_MAX_RETRIES=2` + `gate_block_retries` 追踪；同一 block reason 超限后不再注入 synthetic_hint |
| realToolEvidence 识别 | ✅ 已修复 | 新增 `python3 -m py_compile` / `git diff --check` / `dll-agent doctor` / `result:(ok|warn)` 匹配 |
| Skill activation 重复证据 | ✅ 已修复 | 同一 skill + 同一 fingerprint 不再重复写入 evidence |
| Finalization 上下文压缩 | ✅ 已修复 | `buildFinalReportContext()` 只传目标/reviever/验证/block 摘要 |
| Usage/Quota/Cost 显示与刷新 | ✅ 已修复 | 区分 local est. / provider billed / provider balance；Quota TTL=300s + stale 标记 + 刷新时间显示 |
| 自举升级闭环 | ✅ 已实现 | self-upgrade skill + MCP manager + 脚本工具箱 + 升级守卫 |

### ❌ 尚未实现

| 特性 | 说明 |
|---|---|
| 自动安装外部服务 | 不在范围内（违反安全策略） |
| 多模型并行技能评审 | 不在范围内（cost 过高） |
| 大规模 TUI 重构 | 不在范围内 |
| 无边界自我重构 | 不在范围内（self-repair 仅做最小补丁） |

## 下一步任务

1. ~~**P0**：`export namespace` → flat exports 重构~~ ✅ 已完成 (本轮)
2. ~~**P0**：修复 `triggers.ts` 自引用 false positive~~ ✅ 已完成 (本轮)
3. ~~**P0**：修复 `updateState` 中 `repeatedToolFailure: false` 硬编码~~ ✅ 已完成
4. ~~**P0**：修复 doctor session state false positive~~ ✅ 已完成 (本轮)
5. **P1**：添加 cost-cap 和 evidence 单元测试
5. **P1**：添加 prompt.ts supervisor 集成测试（Effect test framework）
6. **P2**：Evidence file rotation 和 session 目录清理
7. **P2**：Supervisor Effect.sync() 包装，确保 Effect fiber 模型兼容

## 验证状态

| 验证 | 命令 | 结果 |
|---|---|---|
| TypeScript typecheck | `bun run --cwd packages/opencode typecheck` | ✅ tsgo --noEmit: 0 errors |
| Unit tests | `bun test test/dll-agent/` | ✅ 181 pass, 0 fail (9 files) |
| Tool system tests | `bun test test/dll-agent/tools.test.ts` | ✅ 58 pass, 0 fail |
| Wrapper syntax | `python3 -m py_compile dll-agent dll-agent-quota` | ✅ OK |
| Doctor | `dll-agent doctor` | ✅ result: warn (only expected API-key-in-memory warning) |
| Git whitespace | `git diff --check` | ✅ clean |
| Global manifest | `~/.dll-agent/global/tools.jsonc` | ✅ 12 tools registered 
