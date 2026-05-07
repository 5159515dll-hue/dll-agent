/**
 * dll-agent skill-registry.ts
 *
 * 内置技能声明，纯数据，无副作用。激活逻辑在 skills.ts，加载策略在 skill-loader.ts。
 * 详见 packages/docs/dll-agent-skills.md。
 *
 * 设计原则：
 * 1. 按需激活 — 不一次性加载所有技能到 prompt。
 * 2. 数据先行 — skill 以 plain data 声明，纯函数激活。
 * 3. 不夺权 — skill 不能绕过 supervisor / evidence gate / secrets redaction。
 * 4. 冷却 — 同一 skill 在相同 fingerprint 下不重复激活。
 * 5. 留痕 — 激活和停用都通过 DllAgentEvidence.write() 写入 evidence。
 */

export type SkillRisk = "low" | "medium" | "high"

export type SkillSignal =
  | "tool_failures_repeated"
  | "tool_failures_high"
  | "permission_denied"
  | "reviewer_conflict"
  | "long_context"
  | "final_claim_no_evidence"
  | "verification_failed"
  | "upgrade_requested"

export interface SkillDefinition {
  /** 唯一标识，kebab-case（如 "repo-doctor"） */
  id: string
  /** 人类可读名称 */
  name: string
  /** 一行说明，中英文皆可 */
  description: string
  /** 语义版本（如 "1.0.0"），用于回滚和审计 */
  version: string
  /** 风险级别 */
  riskLevel: SkillRisk
  /** 触发条件 */
  triggers: {
    /** 用户消息关键词（任一命中即匹配） */
    keywords?: RegExp[]
    /** 修改/查看的文件 glob（任一命中即匹配） */
    fileGlobs?: string[]
    /** 仓库根包含哪些文件时激活 */
    repoMarkers?: string[]
    /** 显式 intent 标签 */
    intents?: string[]
    /**
     * 来自 supervisor 的运行时信号（任一命中即匹配，可绕过
     * requiresExplicitConsent — 因为信号本身就是系统硬证据）。
     * 已知信号：
     *  - "tool_failures_repeated"     连续相同工具失败
     *  - "tool_failures_high"         最近 toolFailures >= 3
     *  - "permission_denied"          permission_denied >= 1
     *  - "reviewer_conflict"          reviewer 冲突
     *  - "long_context"               context_percent >= 40
     *  - "final_claim_no_evidence"    final_claim && !real_tool_evidence
     *  - "verification_failed"        verifiedToolEvidence=false 且最近运行了验证命令
     */
    signals?: SkillSignal[]
  }
  /** 激活策略 */
  activationPolicy: {
    /** 同一 session 中最多激活次数 */
    maxActivationsPerSession: number
    /** 激活间隔（步） */
    minStepInterval: number
    /** 是否要求用户显式同意（用户输入 /skill <name> 才能激活） */
    requiresExplicitConsent?: boolean
  }
  /** 停用条件 */
  deactivationPolicy: {
    /** 当 phase 切换时停用 */
    onPhaseChange?: boolean
    /** 完成 verificationCommands 后自动停用 */
    onVerificationDone?: boolean
    /** 同一错误 fingerprint 最大重复激活次数；超出后永久停用直到 phase 变更 */
    maxFingerprintRepeats?: number
  }
  /** 必需的 skill 前置 */
  requiredSkills?: string[]
  /** 必须可用的工具名（如 "bash", "edit", "read"） */
  requiredTools?: string[]
  /** 可推荐的命令（white-list 显示给 commander） */
  allowedCommands?: string[]
  /** 绝对禁止的命令（rm -rf, curl | sh 等） */
  forbiddenCommands?: string[]
  /** 完成时建议的验证命令；evidence gate 会引用 */
  verificationCommands?: string[]
  /** 必须输出的 evidence 类型（如 "command_output", "file_path", "test_result"） */
  requiredEvidence: string[]
  /** 冷却配置 */
  cooldown: {
    /** 同名技能最小激活间隔（秒），与 activationPolicy.minStepInterval 叠加 */
    minIntervalSec: number
    /** 相同 fingerprint（normalized error/keyword）最小间隔（秒） */
    fingerprintIntervalSec: number
  }
  /** 成本策略 */
  costPolicy: {
    /** 激活后 single-call cap 调整系数（如 0.5 表示减半） */
    singleCallCapMultiplier: number
    /** 是否允许触发 OpenAI subagent */
    allowOpenAI: boolean
    /** 是否允许触发其他高成本 reviewer */
    allowExpensiveReviewer: boolean
  }
  /** 安全策略 */
  securityPolicy: {
    /** 是否必须脱敏输出（默认 true） */
    requireRedaction: boolean
    /** 是否允许写文件到项目外 */
    allowExternalWrite: boolean
    /** 是否允许执行网络请求 */
    allowNetworkFetch: boolean
  }
  /** 回滚策略 */
  rollbackPolicy: {
    /** 是否支持自动回滚 */
    autoRollback: boolean
    /** 回滚前必须的确认（如 "git stash list", "git status"） */
    preRollbackChecks: string[]
    /** 回滚操作（命令列表） */
    rollbackCommands: string[]
  }
}

export const SKILL_REGISTRY: SkillDefinition[] = [
  // ─── Phase 1 Core Skills ──────────────────────────────────────────────────
  {
    id: "repo-doctor",
    name: "repo-doctor",
    description: "Repository health check: git status, typecheck baseline, lint readiness, dep audit.",
    version: "1.0.0",
    riskLevel: "low",
    triggers: {
      keywords: [/项目.*乱|repo.*health|健康检查|baseline.*broken|项目.*坏|diagnose|repo doctor|跑不起来|启动失败|依赖.*问题/i],
      repoMarkers: [".git", "package.json"],
      intents: ["repo-doctor", "diagnose"],
      signals: ["tool_failures_high", "permission_denied"],
    },
    activationPolicy: { maxActivationsPerSession: 3, minStepInterval: 4 },
    deactivationPolicy: { onPhaseChange: true, onVerificationDone: true },
    requiredTools: ["bash", "read", "glob"],
    allowedCommands: ["git status", "git diff --check", "bun typecheck", "bun run --cwd packages/opencode typecheck"],
    forbiddenCommands: ["git push --force", "git reset --hard", "rm -rf"],
    requiredEvidence: ["command_output", "file_path", "error_excerpt"],
    verificationCommands: ["git status --porcelain", "git diff --check"],
    cooldown: { minIntervalSec: 60, fingerprintIntervalSec: 300 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "self-repair",
    name: "self-repair",
    description: "Self-repair for dll-agent wrapper, profile, supervisor, evidence, TUI, quota, doctor issues. Minimal patch only.",
    version: "1.0.0",
    riskLevel: "high",
    triggers: {
      keywords: [/dll-agent.*启动失败|dll-agent.*error|状态显示错误|模型路由.*错|evidence.*写入.*异常|doctor.*报错|wrapper.*broken|supervisor.*broken/i],
      intents: ["self-repair", "fix-dll-agent"],
      signals: ["tool_failures_repeated", "verification_failed"],
    },
    activationPolicy: { maxActivationsPerSession: 2, minStepInterval: 6, requiresExplicitConsent: true },
    deactivationPolicy: { onPhaseChange: true, onVerificationDone: true },
    requiredTools: ["bash", "read", "edit"],
    allowedCommands: ["git tag", "git stash", "git reset --soft", "python3 -m py_compile"],
    forbiddenCommands: ["git push", "git push --force", "rm -rf /", "sudo", "pip install -g", "npm install -g"],
    requiredEvidence: ["command_output", "file_path", "before_after_diff"],
    verificationCommands: ["python3 -m py_compile $HOME/.local/bin/dll-agent", "python3 -m py_compile $HOME/.local/bin/dll-agent-quota", "dll-agent doctor"],
    cooldown: { minIntervalSec: 600, fingerprintIntervalSec: 1800 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: true, allowExpensiveReviewer: true },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: true, preRollbackChecks: ["git stash list", "git status"], rollbackCommands: ["git stash pop", "git reset --soft HEAD~1"] },
  },
  {
    id: "security-redaction",
    name: "security-redaction",
    description: "Secret redaction and log safety. Never write secrets to evidence/logs/reports.",
    version: "1.0.0",
    riskLevel: "medium",
    triggers: {
      keywords: [
        /api[_-]?key|api_token|access[_-]?token|bearer\s+|password|passwd|secret|cookie|ssh.*key/i,
        /OPENAI_API_KEY|DEEPSEEK_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|ANTHROPIC_API_KEY/i,
      ],
      intents: ["security", "redaction"],
    },
    activationPolicy: { maxActivationsPerSession: 4, minStepInterval: 1 },
    deactivationPolicy: { onPhaseChange: true, maxFingerprintRepeats: 3 },
    requiredTools: [],
    allowedCommands: [],
    forbiddenCommands: ["echo $", "env | grep", "printenv"],
    requiredEvidence: ["redaction_applied"],
    verificationCommands: [],
    cooldown: { minIntervalSec: 10, fingerprintIntervalSec: 60 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "test-gate",
    name: "test-gate",
    description: "Tests & verification gate. Real run required; never claim verified without stdout.",
    version: "1.0.0",
    riskLevel: "medium",
    triggers: {
      fileGlobs: ["**/*.test.ts", "**/test/**", "**/*.spec.ts"],
      keywords: [/run.*test|跑测试|测试.*通过|all tests pass|bun test|pytest|npm test|vitest|typecheck/i],
      intents: ["test", "verify"],
      signals: ["final_claim_no_evidence", "verification_failed"],
    },
    activationPolicy: { maxActivationsPerSession: 5, minStepInterval: 2 },
    deactivationPolicy: { onVerificationDone: true },
    requiredTools: ["bash"],
    allowedCommands: ["bun test", "bun run --cwd packages/opencode test", "pytest -q"],
    forbiddenCommands: ["bun test --bail=0 --update-snapshot"],
    requiredEvidence: ["test_stdout", "pass_fail_count", "exit_code"],
    verificationCommands: ["bun test", "bun run --cwd packages/opencode test"],
    cooldown: { minIntervalSec: 30, fingerprintIntervalSec: 120 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "docs-sync",
    name: "docs-sync",
    description: "Docs/plan vs implementation sync. Block 'plan masquerading as done'.",
    version: "1.0.0",
    riskLevel: "low",
    triggers: {
      fileGlobs: ["**/*.md", "docs/**"],
      keywords: [/计划|roadmap|plan\.md|实现状态|未完成|TODO|已实现|部分实现/i],
      intents: ["docs", "plan-sync"],
    },
    activationPolicy: { maxActivationsPerSession: 3, minStepInterval: 3 },
    deactivationPolicy: { onPhaseChange: true },
    requiredTools: ["read", "glob"],
    allowedCommands: [],
    forbiddenCommands: [],
    requiredEvidence: ["status_tag_per_feature"],
    verificationCommands: ["git diff --stat"],
    cooldown: { minIntervalSec: 60, fingerprintIntervalSec: 300 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "cost-guard",
    name: "cost-guard",
    description: "Multi-model cost & quota guard. Lower single-call cap when active. Default DeepSeek execution.",
    version: "1.0.0",
    riskLevel: "medium",
    triggers: {
      keywords: [/openai|gpt-5|expensive|超出|预算|cost.*cap|quota.*exceeded|多模型.*审查/i],
      intents: ["cost", "quota"],
      signals: ["long_context"],
    },
    activationPolicy: { maxActivationsPerSession: 4, minStepInterval: 2 },
    deactivationPolicy: { onPhaseChange: true },
    requiredTools: ["bash"],
    allowedCommands: ["dll-agent-quota"],
    forbiddenCommands: [],
    requiredEvidence: ["cost_estimate", "quota_remaining"],
    verificationCommands: ["dll-agent-quota"],
    cooldown: { minIntervalSec: 30, fingerprintIntervalSec: 120 },
    costPolicy: { singleCallCapMultiplier: 0.2, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "cross-review",
    name: "cross-review",
    description: "Multi-model cross-review for stuck tasks, reviewer conflicts, or repeated failures. Cooldown-enforced.",
    version: "1.0.0",
    riskLevel: "high",
    triggers: {
      keywords: [/连续.*失败|需求.*冲突|实现.*冲突|用户.*纠偏|单模型.*错误|reviewer.*conflict|交叉审查|blind.?spot/i],
      intents: ["cross-review", "unblock"],
      signals: ["reviewer_conflict", "tool_failures_repeated"],
    },
    activationPolicy: { maxActivationsPerSession: 3, minStepInterval: 5 },
    deactivationPolicy: { onPhaseChange: true, onVerificationDone: true, maxFingerprintRepeats: 2 },
    requiredTools: ["task"],
    allowedCommands: [],
    forbiddenCommands: [],
    requiredEvidence: ["reviewer_conclusion", "conflict_resolution"],
    verificationCommands: [],
    cooldown: { minIntervalSec: 300, fingerprintIntervalSec: 600 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: true, allowExpensiveReviewer: true },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: true },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "ux-review",
    name: "ux-review",
    description: "CLI/TUI UX review: clarity, discoverability, recoverability. Prioritize diagnosability over visual polish.",
    version: "1.0.0",
    riskLevel: "low",
    triggers: {
      fileGlobs: ["**/cli/**", "**/tui/**", "**/*.tsx"],
      keywords: [/CLI|TUI|terminal UI|用户体验|UX|启动页|状态面板|quota.*显示|错误提示|command.*提示/i],
      intents: ["cli-ux", "tui-review"],
    },
    activationPolicy: { maxActivationsPerSession: 3, minStepInterval: 3 },
    deactivationPolicy: { onPhaseChange: true },
    requiredTools: [],
    allowedCommands: [],
    forbiddenCommands: [],
    requiredEvidence: ["before_after_screenshot_or_description"],
    verificationCommands: [],
    cooldown: { minIntervalSec: 60, fingerprintIntervalSec: 300 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
  },
  {
    id: "self-upgrade",
    name: "self-upgrade",
    description: "Self-upgrade for dll-agent: generates upgrade task decomposition, dependency change list, risk/rollback plan, and verification commands. Writes upgrade evidence with version/changes/verification.",
    version: "1.0.0",
    riskLevel: "high",
    triggers: {
      keywords: [/self[- ]?upgrade|自举升级|upgrade dll-agent|升级 dll-agent|self[- ]?improve|self[- ]?update|autonomous upgrade/i],
      fileGlobs: ["packages/opencode/src/dll-agent/**"],
      intents: ["self-upgrade", "upgrade"],
      signals: ["upgrade_requested", "verification_failed"],
    },
    activationPolicy: { maxActivationsPerSession: 2, minStepInterval: 8, requiresExplicitConsent: true },
    deactivationPolicy: { onPhaseChange: true, onVerificationDone: true },
    requiredTools: ["bash", "read", "edit", "task"],
    allowedCommands: ["bun typecheck", "bun test test/dll-agent/", "dll-agent doctor", "git diff --check", "python3 -m py_compile"],
    forbiddenCommands: ["git push", "git push --force", "rm -rf", "sudo"],
    requiredEvidence: ["upgrade_task_list", "dependency_changes", "risk_assessment", "verification_results", "rollback_commands"],
    verificationCommands: [
      "bun run --cwd packages/opencode typecheck",
      "bun test --cwd packages/opencode test/dll-agent/",
      "dll-agent doctor",
      "git -C . diff --check",
    ],
    cooldown: { minIntervalSec: 600, fingerprintIntervalSec: 3600 },
    costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: true, allowExpensiveReviewer: true },
    securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
    rollbackPolicy: {
      autoRollback: true,
      preRollbackChecks: ["git status --porcelain", "git stash list", "git log --oneline -5"],
      rollbackCommands: ["git checkout -- .", "git stash pop"],
    },
  },
]


