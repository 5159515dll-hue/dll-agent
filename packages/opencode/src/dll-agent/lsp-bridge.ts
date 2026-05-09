/**
 * dll-agent lsp-bridge.ts
 *
 * Bridge between lsp-strategy and opencode LSP launch pipeline.
 *
 * Provides prewarm hints and doctor checks for LSP activation.
 * Actual prewarm launch is triggered by the LSP initialization code.
 *
 * Principle: project-main language prewarm, auxiliary languages lazy,
 * excluded directories (node_modules, .git, etc.) never scanned.
 */
import {
  computePrewarmPlan,
  detectProjectLanguage,
  getPrewarmFiles,
  isLspExcludedPath,
  DEFAULT_LSP_STRATEGY,
  type DetectedLanguage,
  type LspStrategyConfig,
} from "./lsp-strategy"
import { write as writeEvidence } from "./evidence"

export interface LspBridgeResult {
  /** Main language detected */
  mainLanguage: DetectedLanguage
  /** Languages to prewarm */
  prewarm: DetectedLanguage[]
  /** Languages to keep lazy */
  lazy: DetectedLanguage[]
  /** All detected languages */
  allDetected: DetectedLanguage[]
  /** Representative files for prewarm */
  prewarmFiles: Record<DetectedLanguage, string[]>
  /** Any configuration warnings */
  warnings: string[]
}

export interface LspPrewarmTarget {
  language: DetectedLanguage
  file: string
}

export interface LspPrewarmRuntimeResult {
  plan: LspBridgeResult
  touched: string[]
  skipped: Array<{ file: string; reason: string }>
  failed: Array<{ file: string; error: string }>
}

export interface LspPrewarmRuntimeAdapter {
  hasClients: (file: string) => boolean | Promise<boolean>
  touchFile: (file: string) => void | Promise<void>
}

/**
 * Compute LSP prewarm plan for a project.
 * Returns prewarm hints that the LSP initialization code can use.
 */
export function computeLspBridgePlan(
  projectRoot: string,
  config?: Partial<LspStrategyConfig>,
): LspBridgeResult {
  const mergedConfig = { ...DEFAULT_LSP_STRATEGY, ...config }
  const plan = computePrewarmPlan(projectRoot, mergedConfig)
  const warnings: string[] = []

  const prewarmFiles: Record<DetectedLanguage, string[]> = {} as Record<DetectedLanguage, string[]>

  for (const lang of plan.prewarm) {
    const files = getPrewarmFiles(
      projectRoot,
      lang,
      mergedConfig.maxPrewarmFilesPerLanguage,
      mergedConfig.excludeGlobs,
    )
    prewarmFiles[lang] = files

    if (files.length === 0 && lang !== "unknown") {
      warnings.push(`No source files found for ${lang} LSP prewarm in ${projectRoot}`)
    }
  }

  if (plan.prewarm.length > 0 && plan.prewarm[0] !== "unknown") {
    const totalFiles = Object.values(prewarmFiles).reduce((sum, arr) => sum + arr.length, 0)
    if (totalFiles > mergedConfig.maxTotalPrewarmFiles) {
      warnings.push(
        `Prewarm file count (${totalFiles}) exceeds max (${mergedConfig.maxTotalPrewarmFiles}) — files will be truncated`,
      )
      let remaining = mergedConfig.maxTotalPrewarmFiles
      for (const lang of plan.prewarm) {
        const files = prewarmFiles[lang] ?? []
        prewarmFiles[lang] = files.slice(0, Math.max(0, remaining))
        remaining -= prewarmFiles[lang].length
      }
    }
  }

  // Check for over-scanning risk
  for (const lang of plan.prewarm) {
    const files = prewarmFiles[lang] ?? []
    const hasExcludedFiles = files.some((f) => isLspExcludedPath(f))
    if (hasExcludedFiles) {
      warnings.push(`WARNING: ${lang} prewarm files contain paths in excluded directories`)
    }
  }

  writeEvidence("lsp.prewarm_plan", {
    mainLanguage: plan.prewarm[0] ?? "unknown",
    prewarmCount: plan.prewarm.length,
    lazyCount: plan.lazy.length,
    mode: mergedConfig.mode,
    warnings,
  })

  return {
    mainLanguage: plan.prewarm[0] ?? "unknown",
    prewarm: plan.prewarm,
    lazy: plan.lazy,
    allDetected: plan.allDetected,
    prewarmFiles,
    warnings,
  }
}

export function buildLspPrewarmTargets(plan: LspBridgeResult, maxFiles = DEFAULT_LSP_STRATEGY.maxTotalPrewarmFiles): LspPrewarmTarget[] {
  return plan.prewarm.flatMap((language) =>
    (plan.prewarmFiles[language] ?? [])
      .filter((file) => !isLspExcludedPath(file))
      .slice(0, maxFiles)
      .map((file) => ({ language, file })),
  ).slice(0, maxFiles)
}

export async function runLspPrewarmRuntime(input: {
  projectRoot: string
  adapter: LspPrewarmRuntimeAdapter
  config?: Partial<LspStrategyConfig>
  sessionID?: string
}): Promise<LspPrewarmRuntimeResult> {
  const plan = computeLspBridgePlan(input.projectRoot, input.config)
  const targets = buildLspPrewarmTargets(plan)
  const touched: string[] = []
  const skipped: Array<{ file: string; reason: string }> = []
  const failed: Array<{ file: string; error: string }> = []

  writeEvidence("lsp.prewarm_scheduled", {
    mainLanguage: plan.mainLanguage,
    prewarm: plan.prewarm,
    lazy: plan.lazy,
    targetCount: targets.length,
    warnings: plan.warnings,
  }, input.sessionID)

  for (const target of targets) {
    try {
      const available = await input.adapter.hasClients(target.file)
      if (!available) {
        skipped.push({ file: target.file, reason: "no LSP server available for file type" })
        writeEvidence("lsp.prewarm_skipped", {
          language: target.language,
          file: target.file,
          reason: "no LSP server available for file type",
        }, input.sessionID)
        continue
      }
      await input.adapter.touchFile(target.file)
      touched.push(target.file)
    } catch (error) {
      failed.push({ file: target.file, error: String(error) })
      writeEvidence("lsp.prewarm_failed", {
        language: target.language,
        file: target.file,
        error: String(error),
      }, input.sessionID)
    }
  }

  writeEvidence("lsp.prewarm_finished", {
    mainLanguage: plan.mainLanguage,
    touchedCount: touched.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
  }, input.sessionID)

  return { plan, touched, skipped, failed }
}

/**
 * Doctor check for LSP configuration.
 * Returns warnings if there are risks of over-scanning, excluded dir leakage, etc.
 */
export function lspDoctorCheck(projectRoot: string): {
  ok: boolean
  warnings: string[]
  mainLanguage: DetectedLanguage
  mode: string
  prewarmCount: number
  lazyCount: number
  targetCount: number
  excludedTargetCount: number
} {
  const mainLanguage = detectProjectLanguage(projectRoot)
  const config = DEFAULT_LSP_STRATEGY
  const bridgePlan = computeLspBridgePlan(projectRoot, { ...config })
  const plan = computePrewarmPlan(projectRoot, config)
  const targets = buildLspPrewarmTargets(bridgePlan)
  const excludedTargetCount = targets.filter((target) => isLspExcludedPath(target.file)).length

  const warnings: string[] = []

  if (mainLanguage === "unknown") {
    warnings.push("No main language detected — LSP prewarm will be skipped")
  }

  if (config.mode === "all-detected") {
    warnings.push(
      "WARNING: mode=all-detected will prewarm all detected language LSPs. " +
      "Consider using mode=project-main for better performance.",
    )
  }

  if (config.mode === "lazy") {
    warnings.push("mode=lazy: no LSP prewarm will occur. Startup may be faster but first file access will be slower.")
  }

  const totalPrewarm = plan.prewarm.length
  if (totalPrewarm > 3) {
    warnings.push(`Potentially too many LSP prewarm targets (${totalPrewarm}) — consider limiting`)
  }
  if (excludedTargetCount > 0) {
    warnings.push(`WARNING: LSP prewarm target includes excluded directories (${excludedTargetCount})`)
  }

  return {
    ok: warnings.filter((w) => w.startsWith("WARNING")).length === 0,
    warnings: [...bridgePlan.warnings, ...warnings],
    mainLanguage,
    mode: config.mode,
    prewarmCount: plan.prewarm.length,
    lazyCount: plan.lazy.length,
    targetCount: targets.length,
    excludedTargetCount,
  }
}
