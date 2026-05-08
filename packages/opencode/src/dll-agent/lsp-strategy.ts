/**
 * dll-agent lsp-strategy.ts
 *
 * Risk/performance-aware LSP prewarm strategy.
 * Default: only prewarm the project's main language LSP.
 * Auxiliary language LSPs stay lazy (activated on first relevant file access).
 *
 * Principles:
 * 1. Detect project main language from standard config files
 * 2. Only prewarm main language LSP (read few representative files)
 * 3. Auxiliary LSPs: lazy activation on first file touch
 * 4. Never scan full repo; never activate unrelated LSPs
 * 5. Excluded dirs: node_modules, .git, dist, build, coverage, .venv, etc.
 */

import fs from "fs"
import path from "path"

// ─── Language Detection ─────────────────────────────────────────────────────

export type DetectedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "unknown"

export interface LspStrategyConfig {
  mode: "lazy" | "project-main" | "all-detected"
  maxPrewarmFilesPerLanguage: number
  maxTotalPrewarmFiles: number
  timeoutSeconds: number
  /** Directory patterns to exclude from scanning */
  excludeGlobs: string[]
  /** Languages to always include even if not detected */
  includeLanguages: DetectedLanguage[]
  /** Languages to never prewarm */
  excludeLanguages: DetectedLanguage[]
}

export const DEFAULT_LSP_STRATEGY: LspStrategyConfig = {
  mode: "project-main",
  maxPrewarmFilesPerLanguage: 5,
  maxTotalPrewarmFiles: 20,
  timeoutSeconds: 30,
  excludeGlobs: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/outputs/**",
    "**/.venv/**",
    "**/venv/**",
    "**/__pycache__/**",
    "**/.mypy_cache/**",
    "**/.pytest_cache/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.cache/**",
    "**/.turbo/**",
    "**/target/**",
    "**/.tox/**",
    "**/.eggs/**",
  ],
  includeLanguages: [],
  excludeLanguages: [],
}

// ─── Language → LSP mapping ─────────────────────────────────────────────────

const LANGUAGE_LSP_MAP: Record<DetectedLanguage, string[]> = {
  typescript: ["typescript", "ts", "tsx"],
  javascript: ["javascript", "js"],
  python: ["python", "pyright"],
  go: ["go", "gopls"],
  rust: ["rust-analyzer", "rust"],
  java: ["java", "jdtls"],
  kotlin: ["kotlin"],
  swift: ["swift", "sourcekit-lsp"],
  ruby: ["ruby", "solargraph"],
  php: ["php", "intelephense"],
  unknown: [],
}

const LANGUAGE_EXTENSIONS: Record<DetectedLanguage, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi", ".pyx"],
  go: [".go"],
  rust: [".rs", ".rlib"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  ruby: [".rb"],
  php: [".php"],
  unknown: [],
}

// ─── Detection Logic ────────────────────────────────────────────────────────

const PROJECT_FILE_MAP: Record<string, DetectedLanguage> = {
  "package.json": "typescript",
  "tsconfig.json": "typescript",
  "tsconfig.base.json": "typescript",
  "vite.config.ts": "typescript",
  "next.config.ts": "typescript",
  "tsconfig.node.json": "typescript",
  "jsconfig.json": "javascript",
  "vite.config.js": "javascript",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "setup.cfg": "python",
  "Pipfile": "python",
  "go.mod": "go",
  "go.sum": "go",
  "Cargo.toml": "rust",
  "Cargo.lock": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  "settings.gradle": "java",
  "settings.gradle.kts": "kotlin",
  "Package.swift": "swift",
  "Gemfile": "ruby",
  "composer.json": "php",
}

/**
 * Detect the main language of a project by scanning for standard config files.
 * Returns the first detected language (priority order).
 */
export function detectProjectLanguage(projectRoot: string): DetectedLanguage {
  const priority: DetectedLanguage[] = [
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "kotlin",
    "swift",
    "ruby",
    "php",
  ]

  for (const lang of priority) {
    for (const [file, detectedLang] of Object.entries(PROJECT_FILE_MAP)) {
      if (detectedLang === lang) {
        const filePath = path.join(projectRoot, file)
        try {
          if (fs.existsSync(filePath)) return lang
        } catch {
          continue
        }
      }
    }
  }

  return "unknown"
}

/**
 * Get representative files for LSP prewarm.
 * Returns a small set of source files to warm up the language server,
 * never scanning excluded directories or reading the full repo.
 */
export function getPrewarmFiles(
  projectRoot: string,
  language: DetectedLanguage,
  maxFiles: number,
  excludeGlobs: string[],
): string[] {
  if (language === "unknown") return []

  const extensions = LANGUAGE_EXTENSIONS[language]
  if (!extensions || extensions.length === 0) return []

  const files: string[] = []
  const excludedDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    "outputs",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".turbo",
    "target",
    ".tox",
    ".eggs",
    ".cache",
  ])

  function walkDir(dir: string, depth: number) {
    if (files.length >= maxFiles || depth > 3) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name.startsWith(".") && entry.name !== ".ts" && entry.name !== ".tsx") continue
      if (excludedDirs.has(entry.name)) continue

      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walkDir(fullPath, depth + 1)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name)
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      }
    }
  }

  walkDir(projectRoot, 0)
  return files.slice(0, maxFiles)
}

/**
 * Determine which LSPs to prewarm based on strategy config.
 */
export function computePrewarmPlan(
  projectRoot: string,
  config: LspStrategyConfig = DEFAULT_LSP_STRATEGY,
): {
  prewarm: DetectedLanguage[]
  lazy: DetectedLanguage[]
  allDetected: DetectedLanguage[]
} {
  const mainLanguage = detectProjectLanguage(projectRoot)

  // Also detect secondary languages (simple heuristic)
  const allDetected: DetectedLanguage[] = []
  if (mainLanguage !== "unknown") allDetected.push(mainLanguage)

  for (const lang of Object.keys(LANGUAGE_EXTENSIONS) as DetectedLanguage[]) {
    if (lang === "unknown" || lang === mainLanguage) continue
    for (const [file, detectedLang] of Object.entries(PROJECT_FILE_MAP)) {
      if (detectedLang === lang) {
        try {
          if (fs.existsSync(path.join(projectRoot, file))) {
            if (!allDetected.includes(lang)) allDetected.push(lang)
          }
        } catch {
          continue
        }
      }
    }
  }

  // Apply include/exclude
  const filtered = allDetected.filter((l) => !config.excludeLanguages.includes(l))
  for (const l of config.includeLanguages) {
    if (!filtered.includes(l)) filtered.push(l)
  }

  switch (config.mode) {
    case "lazy":
      return { prewarm: [], lazy: filtered, allDetected: filtered }
    case "all-detected":
      return { prewarm: filtered, lazy: [], allDetected: filtered }
    case "project-main":
    default:
      return {
        prewarm: mainLanguage !== "unknown" && !config.excludeLanguages.includes(mainLanguage)
          ? [mainLanguage]
          : [],
        lazy: filtered.filter((l) => l !== mainLanguage),
        allDetected: filtered,
      }
  }
}

/**
 * Get the LSP server names for a given language.
 */
export function lspNamesForLanguage(language: DetectedLanguage): string[] {
  return LANGUAGE_LSP_MAP[language] ?? []
}

/**
 * Check if a file path is in an excluded directory (for LSP scanning).
 */
export function isLspExcludedPath(filePath: string): boolean {
  const excludedDirs = [
    "node_modules", ".git", "dist", "build", "coverage", "outputs",
    ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".next", ".nuxt", ".cache", ".turbo", "target", ".tox", ".eggs",
  ]
  return excludedDirs.some((dir) => {
    const pattern = new RegExp(`(^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|/)`)
    return pattern.test(filePath)
  })
}
