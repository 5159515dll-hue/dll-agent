# dll-agent Skills

dll-agent 的 skill 系统是**受控按需加载**的工程能力包。Skill 不是普通 prompt
拼接，也不绕过 supervisor / evidence gate / secrets redaction。

## 设计原则

1. **按需激活**：根据用户消息关键词、修改的文件类型、仓库结构、任务意图、工具失败信号选择性激活，不一次性把所有技能塞进 prompt。
2. **数据先行**：skill 在 `skill-registry.ts` 中以 plain data 声明；激活逻辑在 `skills.ts` 中是纯函数，加载策略在 `skill-loader.ts` 中控制。
3. **三层加载**：metadata only → summary mode → full mode。只有真正激活的技能才加载完整规则，避免 prompt 污染。
4. **不夺权**：skill 只能提供检查清单、命令建议、验证策略；不能跳过权限弹窗、不能自动安装全局软件、不能写 secrets。
5. **冷却**：同一 skill 在相同 fingerprint 下不重复激活；`maxFingerprintRepeats` 超出后永久停用直到 phase 变更。
6. **留痕**：激活和停用都通过 `DllAgentEvidence.write()` 写入 evidence，输出结构化 `SkillActivationOutput`。

## Skill Schema

```ts
interface SkillDefinition {
  /** 唯一标识，kebab-case */
  id: string
  /** 人类可读名称 */
  name: string
  /** 一行说明 */
  description: string
  /** 语义版本（用于回滚和审计） */
  version: string
  /** 风险级别 */
  riskLevel: "low" | "medium" | "high"
  /** 触发条件 */
  triggers: {
    keywords?: RegExp[]
    fileGlobs?: string[]
    repoMarkers?: string[]
    intents?: string[]
  }
  /** 激活策略 */
  activationPolicy: {
    maxActivationsPerSession: number
    minStepInterval: number
    requiresExplicitConsent?: boolean
  }
  /** 停用条件 */
  deactivationPolicy: {
    onPhaseChange?: boolean
    onVerificationDone?: boolean
    maxFingerprintRepeats?: number
  }
  /** 必须的 skill 前置 */
  requiredSkills?: string[]
  /** 必须可用的工具名 */
  requiredTools?: string[]
  /** 可推荐的命令 */
  allowedCommands?: string[]
  /** 绝对禁止的命令 */
  forbiddenCommands?: string[]
  /** 验证命令；evidence gate 会引用 */
  verificationCommands?: string[]
  /** 必须输出的 evidence 类型 */
  requiredEvidence: string[]
  /** 冷却配置 */
  cooldown: {
    minIntervalSec: number
    fingerprintIntervalSec: number
  }
  /** 成本策略 */
  costPolicy: {
    singleCallCapMultiplier: number
    allowOpenAI: boolean
    allowExpensiveReviewer: boolean
  }
  /** 安全策略 */
  securityPolicy: {
    requireRedaction: boolean
    allowExternalWrite: boolean
    allowNetworkFetch: boolean
  }
  /** 回滚策略 */
  rollbackPolicy: {
    autoRollback: boolean
    preRollbackChecks: string[]
    rollbackCommands: string[]
  }
}
```

## 内置 Skills

| id | 用途 | risk | 版本 | 触发示例 |
|---|---|---|---|---|
| `repo-doctor` | 仓库健康检查（git status / typecheck / lint / dep audit） | low | 1.0.0 | 用户提到"项目很乱"、启动失败、`.git/` 存在 |
| `self-repair` | dll-agent 自身修复（wrapper / profile / supervisor / evidence / TUI / quota / doctor） | high | dll-agent 启动失败、状态错误、doctor 报警 |
| `security-redaction` | 密钥脱敏与日志安全 | medium | 出现 `api_key`、`token`、`Bearer` 关键词 |
| `test-gate` | 测试与验证门禁（必须实际运行，不能无验证声称完成） | medium | 用户说"运行测试"、修改 `*.test.ts` |
| `docs-sync` | 文档/计划与实现一致性检查 | low | 修改 `*.md`、`docs/` |
| `cost-guard` | 多模型成本与 quota 守卫 | medium | 检测到 OpenAI/付费模型即将调用 |
| `cross-review` | 疑难问题多模型交叉审查 | high | 连续失败、需求冲突、reviewer conflict |
| `ux-review` | CLI/TUI 用户体验检查（可诊断性优先） | low | 修改 `cli/`、`tui/`、`*.tsx` |
| `self-upgrade` | 自举升级：生成升级任务分解、依赖变更、风险/回滚、验证命令 | high | `self-upgrade` 关键词、dll-agent 源码变更、`upgrade_requested` 信号 |

## 技能触发逻辑

技能不能靠模型"自觉想起来"。触发来源包括：

- 用户输入关键词（regex 匹配）
- 文件类型（修改/查看的文件 glob）
- 仓库标记（`.git`、`package.json` 等）
- 显式 intent（slash command 或 metadata）
- 工具失败信号 → 由 supervisor 传递
- 测试/typecheck/doctor 失败信号 → 由 supervisor 传递
- 上下文过长信号 → 由 supervisor 传递
- evidence 缺失信号 → 由 gate 传递

**限制规则（底层代码实现）：**

1. 每轮最多激活 2 个技能（有 high risk skill 时最多 3 个）
2. 同一 skill 在相同 fingerprint 下不重复激活
3. cost-guard 激活时 OpenAI 相关技能必须经过 cost guard
4. requiresExplicitConsent 的 skill 必须用户显式同意

## 三层加载

### Level 1: Metadata Only
只加载技能 id、name、description、trigger 关键词（通过 `SkillRegistry.allMetadata()`）。

### Level 2: Summary Mode
≤200 字符的简短提示字符串，注入 system prompt 末尾（通过 `Skills.summary()`）。

### Level 3: Full Mode
只有在技能真正激活时，才加载完整约束：
- `requiredEvidence`、`verificationCommands`
- `allowedCommands`、`forbiddenCommands`
- `costPolicy`、`securityPolicy`、`rollbackPolicy`

## 技能输出格式

每个技能被激活后，`SkillActivationOutput` 包含：

```ts
{
  skill_id: string
  trigger_reason: string
  risk_level: "low" | "medium" | "high"
  findings: string[]
  recommended_actions: string[]
  blocked_actions: string[]
  required_evidence: string[]
  verification_plan: string[]
  cost_impact: { singleCallCapMultiplier, allowOpenAI, allowExpensiveReviewer }
  security_impact: { requireRedaction, allowExternalWrite, allowNetworkFetch }
  blocking: boolean
  block_reason: string | null
  required_fix: string | null
  required_verification: string | null
  next_step: string
}
```

## 与其他模块的关系

- **triggers.ts**：识别事件和信号（关键词、文件类型、工具失败、测试失败等）
- **skill-registry.ts**：定义技能（纯数据声明）
- **skills.ts**：选择并激活技能（纯函数，含 fingerprint 和 cooldown 控制）
- **skill-loader.ts**：控制三层加载策略和结构化输出格式
- **supervisor.ts**：根据触发信号和技能建议作出调度决策
- **gates.ts**：判断是否允许最终完成声明（引用技能的 verificationCommands）
- **evidence.ts**：记录关键动作、证据和技能激活情况

技能系统不能替代 supervisor。是否触发 reviewer、是否阻断完成、是否需要 final audit，必须由 supervisor / gates 决定。技能只能提供专业能力和检查策略。

## 反模式（禁止）

- ❌ 激活一个 skill 就静默降级安全规则
- ❌ skill 调用 `bun add -g`、`npm install -g`、`brew install` 而不询问
- ❌ skill 把 secrets 写入 evidence
- ❌ skill 让 OpenAI 成为默认主模型
- ❌ skill 一次性塞 8 个全部到 prompt
- ❌ skill 绕过 supervisor、evidence gate、final gate
- ❌ 在没有命令输出、测试结果、文件路径、日志或 evidence 的情况下声称"已完成"

## 实现状态

| 特性 | 状态 | 文件 |
|---|---|---|
| SkillDefinition 接口（完整字段） | ✅ 已实现 | `skill-registry.ts:12-88` |
| 8 个内置技能定义 | ✅ 已实现 | `skill-registry.ts:90-290` |
| self-upgrade 技能 | ✅ 已实现 | `skill-registry.ts` (第 9 个技能) |
| 激活/停用/cooldown/fingerprint 逻辑 | ✅ 已实现 | `skills.ts` |
| 三层加载（metadata/summary/full） | ✅ 已实现 | `skill-loader.ts` |
| 结构化 SkillActivationOutput | ✅ 已实现 | `skill-loader.ts:72-98` |
| 持久化到 ~/.dll-agent/sessions/ | ✅ 已实现 | `skills.ts:persist()` |
| bash 命令拦截（forbiddenCommands） | ✅ 已实现 | `skills.ts:checkForbiddenCommand()` |
| Evidence 记录技能激活 | ✅ 已实现 | `skills.ts:activate()` 侧 |
| 工具失败信号接入 trigger | ⚠️ 部分实现 | 通过 supervisor 传递，未直接 hook |
| 测试覆盖 | ✅ 39 tests pass | `test/dll-agent/` |
| TypeScript 类型检查 | ✅ tsgo --noEmit 通过 | |
| 文档同步 | ✅ 本文档 | `packages/docs/dll-agent-skills.md` |
