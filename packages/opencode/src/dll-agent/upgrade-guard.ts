/**
 * dll-agent Upgrade Guard
 *
 * 升级守卫：升级前 smoke、失败自动回滚、upgrade evidence 写入。
 */

import { write as writeEvidence } from "./evidence"
import { typecheck, runTests, pythonSyntax, doctor, gitDiffCheck } from "./toolbox"

export interface UpgradePlan {
  version: string
  description: string
  taskList: string[]
  dependencyChanges: string[]
  riskAssessment: string
  rollbackCommands: string[]
}

export interface UpgradeEvidence {
  ts: string
  version: string
  preUpgradeSmoke: { passed: boolean; results: string[] }
  postUpgradeSmoke?: { passed: boolean; results: string[] }
  changes: string[]
  verificationResults: Record<string, boolean>
  rollbackPath: string[]
  conclusion: "pass" | "partial" | "fail"
}

/**
 * 运行升级前 smoke check。
 * 返回 true 表示基线通过，可以继续升级。
 */
export function preUpgradeSmoke(sessionID: string): { passed: boolean; results: string[] } {
  const checks = [
    { name: "typecheck", result: typecheck() },
    { name: "tests", result: runTests() },
    { name: "python", result: pythonSyntax() },
    { name: "doctor", result: doctor() },
    { name: "git-diff", result: gitDiffCheck() },
  ]

  const results: string[] = []
  let allPassed = true
  for (const c of checks) {
    const status = c.result.success ? "PASS" : "FAIL"
    results.push(`${c.name}: ${status} (exit=${c.result.exitCode})`)
    if (!c.result.success) allPassed = false
  }

  writeEvidence("upgrade.pre_smoke", {
    passed: allPassed,
    results,
  }, sessionID)

  return { passed: allPassed, results }
}

/**
 * 运行升级后验证。
 */
export function postUpgradeVerify(sessionID: string): { passed: boolean; results: string[] } {
  const checks = [
    { name: "typecheck", result: typecheck() },
    { name: "tests", result: runTests() },
    { name: "python", result: pythonSyntax() },
    { name: "doctor", result: doctor() },
    { name: "git-diff", result: gitDiffCheck() },
  ]

  const results: string[] = []
  let allPassed = true
  for (const c of checks) {
    const status = c.result.success ? "PASS" : "FAIL"
    results.push(`${c.name}: ${status} (exit=${c.result.exitCode})`)
    if (!c.result.success) allPassed = false
  }

  writeEvidence("upgrade.post_verify", {
    passed: allPassed,
    results,
  }, sessionID)

  return { passed: allPassed, results }
}

/**
 * 生成回滚命令列表。
 * 基于 git status 和当前变更。
 */
export function generateRollbackCommands(): string[] {
  return [
    "# Rollback steps:",
    "# 1. Discard all uncommitted changes:",
    "git checkout -- packages/opencode/src/dll-agent/",
    "git checkout -- packages/opencode/test/dll-agent/",
    "# 2. Remove new untracked files (if any):",
    "git clean -fd packages/opencode/src/dll-agent/",
    "# 3. Verify rollback:",
    "bun run --cwd packages/opencode typecheck",
    "bun test --cwd packages/opencode test/dll-agent/",
  ]
}

/**
 * 写入完整 upgrade evidence。
 */
export function writeUpgradeEvidence(
  sessionID: string,
  plan: UpgradePlan,
  preSmoke: { passed: boolean; results: string[] },
  postSmoke: { passed: boolean; results: string[] },
  verification: Record<string, boolean>,
  conclusion: "pass" | "partial" | "fail",
) {
  const evidence: UpgradeEvidence = {
    ts: new Date().toISOString(),
    version: plan.version,
    preUpgradeSmoke: preSmoke,
    postUpgradeSmoke: postSmoke,
    changes: plan.taskList,
    verificationResults: verification,
    rollbackPath: plan.rollbackCommands,
    conclusion,
  }

  writeEvidence("upgrade.completed", evidence, sessionID)
}

/**
 * 生成升级计划结构。
 */
export function createUpgradePlan(
  version: string,
  description: string,
  tasks: string[],
  depChanges: string[],
  risk: string,
  rollback: string[],
): UpgradePlan {
  return {
    version,
    description,
    taskList: tasks,
    dependencyChanges: depChanges,
    riskAssessment: risk,
    rollbackCommands: rollback,
  }
}
