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

/**
 * Doctor check for LSP configuration.
 * Returns warnings if there are risks of over-scanning, excluded dir leakage, etc.
 */
export function lspDoctorCheck(projectRoot: string): {
  ok: boolean
  warnings: string[]
  mainLanguage: DetectedLanguage
  mode: string
} {
  const mainLanguage = detectProjectLanguage(projectRoot)
  const config = DEFAULT_LSP_STRATEGY
  const plan = computePrewarmPlan(projectRoot, config)

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

  return {
    ok: warnings.filter((w) => w.startsWith("WARNING")).length === 0,
    warnings,
    mainLanguage,
    mode: config.mode,
  }
}
