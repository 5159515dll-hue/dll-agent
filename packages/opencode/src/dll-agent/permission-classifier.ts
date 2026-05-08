/**
 * dll-agent permission-classifier.ts
 *
 * Risk-based permission classifier. Classifies shell commands, file operations,
 * and network access by risk level. Used by the dll-agent auto-approval policy
 * to grant low-risk operations automatically while blocking high-risk ones.
 *
 * Design principles:
 * 1. LOW risk → auto-allow: read-only ops, lint/typecheck/test within project
 * 2. MEDIUM risk → confirm-once: writes within project, git commit/stash, dependency install
 * 3. HIGH risk → always confirm or block: destructive ops, secrets, global writes, network
 *
 * All classifications are based on structural patterns, NOT model judgment.
 * Evidence: every decision is logged via evidence.write().
 */

import type { RiskLevel } from "./interfaces"

// ─── Classification Input ───────────────────────────────────────────────────

export interface CommandClassificationInput {
  command: string
  cwd?: string
  projectRoot?: string
}

export interface FileClassificationInput {
  path: string
  operation: "read" | "write" | "delete"
  projectRoot?: string
}

export interface ClassificationResult {
  risk: RiskLevel
  reason: string
  /** true if the operation targets a known secret file/pattern */
  secretRisk: boolean
  /** true if the operation is destructive (cannot be undone) */
  destructive: boolean
  /** true if the operation is outside the project boundary */
  outOfProject: boolean
}

// ─── Secret Path Denylist ──────────────────────────────────────────────────

const SECRET_PATH_PATTERNS: RegExp[] = [
  /\.env(\..*)?$/,
  /\.env\.local$/,
  /credentials\.(json|yml|yaml|toml)$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
  /known_hosts$/,
  /authorized_keys$/,
  /\.netrc$/,
  /\.npmrc$/,
  /\.git-credentials$/,
  /\.docker\/config\.json$/,
  /secrets\.(yml|yaml|json|toml)$/,
  /secret\.(yml|yaml|json)$/,
  /token\.(json|txt)$/,
  /\.aws\/credentials$/,
  /\.aws\/config$/,
  /\.ssh\//,
  /\.gnupg\//,
  /keychain/,
  /login\.keychain/,
]

// ─── Destructive Command Patterns ──────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s/,
  /rm\s+-r\s+-f\s/,
  /rmdir/,
  />\s*\/dev\/(sd|nvme|hd|xvd)/,
  /dd\s+if=/,
  /mkfs\./,
  /fdisk/,
  /:\(\)\s*\{/,      // fork bomb
  />\s*\/etc\//,
  /chmod\s+777/,
  /chmod\s+-R\s+777/,
  /chown\s+-R\s/,
  /chattr\s+-i/,
]

// ─── Global Install / System Modification Patterns ─────────────────────────

const GLOBAL_MODIFY_PATTERNS: RegExp[] = [
  /npm\s+(i|install)\s+-g\s/,
  /npm\s+(i|install)\s+--global\s/,
  /pip\s+install\s+(-g|--global)/,
  /pip3?\s+install\s+(-g|--global)/,
  /brew\s+install/,
  /apt(-get)?\s+(install|remove|purge)/,
  /yum\s+(install|remove)/,
  /dnf\s+(install|remove)/,
  /pacman\s+-S/,
  /sudo\s/,
  /su\s+-/,
  /systemctl\s+(start|stop|enable|disable|restart)/,
  /launchctl\s+(load|unload)/,
  /ln\s+-s\s.*\/usr\//,
  /ln\s+-s\s.*\/etc\//,
  /ln\s+-s\s.*\/var\//,
]

// ─── Remote Publish / Push Patterns ────────────────────────────────────────

const REMOTE_PUBLISH_PATTERNS: RegExp[] = [
  /git\s+push\b(?!.*--dry-run)/,
  /git\s+push\s+--force/,
  /gh\s+pr\s+create/,
  /gh\s+release\s+create/,
  /npm\s+publish/,
  /pnpm\s+publish/,
  /yarn\s+publish/,
  /docker\s+push/,
  /vercel\s+deploy/,
  /flyctl\s+deploy/,
  /terraform\s+apply/,
  /pulumi\s+up/,
  /aws\s+s3\s+(cp|sync).*(--acl|public)/,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
]

// ─── Read-Only Safe Commands ───────────────────────────────────────────────

const SAFE_READ_PATTERNS: RegExp[] = [
  /^(ls|dir|pwd|which|type|command\s+-v|echo|env|printenv|uname|whoami)\b/,
  /^(cat|head|tail|less|more|file)\b/,
  /^(git\s+(status|log|diff|branch|show|stash\s+list|remote\s+-v|diff\s+--check|config\s+--list))/,
  /^(git\s+diff)(?!.*--cached)/,
  /^(node|python3?|ruby|perl|php)\s+--version/,
  /^(node|python3?|ruby)\s+(-c|-e)/,
  /^(python3?\s+-m\s+py_compile)/,
  /^(bun|npm|pnpm|yarn)\s+--version/,
  /^tsc\s+--noEmit/,
  /^tsgo\s+--noEmit/,
  /^(bun|npm|pnpm)\s+(run\b.*)?(typecheck|test\b|lint|doctor)/,
  /^(bun|npm|pnpm)\s+(typecheck|test\b|lint|doctor)/,
  /^(cargo|go|rustc)\s+(check|test\b)/,
  /^(poetry|pipenv|pip)\s+(check|--version)/,
  /^(make|cmake)\s+--version/,
  /^(docker|podman)\s+(ps|images|logs|inspect|version)/,
  /dll-agent\s+doctor/,
]

// ─── Normal Write within Project ───────────────────────────────────────────

const SAFE_WRITE_PATTERNS: RegExp[] = [
  /^(git\s+(add|commit|stash|checkout|switch|restore|merge|rebase|cherry-pick|tag|reset\s+--soft))/,
  /^(bun|npm|pnpm|yarn)\s+(install|add|remove|update)(?!\s+-g)/,
  /^(bun|npm|pnpm|yarn)\s+run\b/,
  /^(pip|pip3|poetry)\s+(install|add)(?!\s+(-g|--global))/,
  /^(cargo)\s+(build|run|test|add|update)/,
  /^(bun|npm|pnpm)\s+create/,
  /^(prettier|eslint|biome|oxlint)\b/,
  /^(python3?\s+-m\s+(pytest|unittest|vitest))/,
  /^(mkdir|touch|cp|mv)\b/,
  /^git\s+diff\s+--check/,
  /^python3?\s+-m\s+py_compile/,
]

// ─── Excluded Directories (never count as project files) ───────────────────

const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "outputs",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "target",
  ".tox",
  ".eggs",
]

// ─── Classification Functions ──────────────────────────────────────────────

function isSecretPath(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath
  return SECRET_PATH_PATTERNS.some((re) => re.test(basename) || re.test(filePath))
}

function isExcludedDir(filePath: string): boolean {
  return EXCLUDED_DIRS.some((dir) => {
    const pattern = new RegExp(`(^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|/)`)
    return pattern.test(filePath)
  })
}

function isWithinProject(filePath: string, projectRoot?: string): boolean {
  if (!projectRoot) return true // no project root, assume safe
  const normalized = filePath.startsWith("/") ? filePath : `/${filePath}`
  const root = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`
  return normalized.startsWith(root)
}

function matchesAny(command: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(command))
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify a shell command by risk level.
 */
export function classifyCommand(input: CommandClassificationInput): ClassificationResult {
  const { command, projectRoot, cwd } = input
  const trimmed = command.trim()

  // 1. Check secrets references
  const secretRisk = SECRET_PATH_PATTERNS.some((re) => re.test(command))

  // 2. Check destructive patterns
  const destructive = matchesAny(trimmed, DESTRUCTIVE_PATTERNS)

  // 3. Check remote publish
  const isRemotePublish = matchesAny(trimmed, REMOTE_PUBLISH_PATTERNS)

  // 4. Check global modification
  const isGlobalModify = matchesAny(trimmed, GLOBAL_MODIFY_PATTERNS)

  // 5. Check read-only safe commands
  const isSafeRead = matchesAny(trimmed, SAFE_READ_PATTERNS)

  // 6. Check normal write within project
  const isSafeWrite = matchesAny(trimmed, SAFE_WRITE_PATTERNS)

  // Check if the command touches paths outside the project
  const outOfProject =
    projectRoot != null && cwd != null && !isExcludedDir(trimmed) && !isWithinProject(cwd, projectRoot)

  // ─── HIGH risk ────────────────────────────────────────────────────
  if (secretRisk) {
    return {
      risk: "high",
      reason: "command references potential secret file or credential path",
      secretRisk: true,
      destructive: false,
      outOfProject,
    }
  }

  if (destructive) {
    return {
      risk: "high",
      reason: "command is destructive (removes files, modifies system devices, or fork-bombs)",
      secretRisk: false,
      destructive: true,
      outOfProject,
    }
  }

  if (isRemotePublish) {
    return {
      risk: "high",
      reason: "command publishes or pushes to remote (git push, npm publish, terraform apply, etc.)",
      secretRisk: false,
      destructive: false,
      outOfProject,
    }
  }

  if (isGlobalModify) {
    return {
      risk: "high",
      reason: "command modifies global system state (sudo, brew install, global npm/pip, systemctl)",
      secretRisk: false,
      destructive: false,
      outOfProject: true,
    }
  }

  // ─── MEDIUM risk ──────────────────────────────────────────────────
  if (outOfProject) {
    return {
      risk: "medium",
      reason: "command operates outside the project boundary",
      secretRisk: false,
      destructive: false,
      outOfProject: true,
    }
  }

  // ─── LOW risk ─────────────────────────────────────────────────────
  if (isSafeRead) {
    return {
      risk: "low",
      reason: "read-only or safe diagnostic command within project",
      secretRisk: false,
      destructive: false,
      outOfProject: false,
    }
  }

  if (isSafeWrite) {
    return {
      risk: "low",
      reason: "safe write/install command within project",
      secretRisk: false,
      destructive: false,
      outOfProject: false,
    }
  }

  // ─── Default: MEDIUM (unknown command) ──────────────────────────────
  return {
    risk: "medium",
    reason: "command type not recognized — requires confirmation",
    secretRisk: false,
    destructive: false,
    outOfProject,
  }
}

/**
 * Classify a file operation by risk level.
 */
export function classifyFileOp(input: FileClassificationInput): ClassificationResult {
  const { path: filePath, operation, projectRoot } = input

  const secretRisk = isSecretPath(filePath)
  const excludedDir = isExcludedDir(filePath)
  const within = isWithinProject(filePath, projectRoot)

  // HIGH: secret files — always block or confirm
  if (secretRisk) {
    return {
      risk: "high",
      reason: `file ${filePath} matches secret/credential pattern`,
      secretRisk: true,
      destructive: operation === "delete",
      outOfProject: false,
    }
  }

  // HIGH: write/delete outside project
  if (!within && !excludedDir && (operation === "write" || operation === "delete")) {
    return {
      risk: "high",
      reason: `${operation} on file outside project boundary: ${filePath}`,
      secretRisk: false,
      destructive: operation === "delete",
      outOfProject: true,
    }
  }

  // HIGH: delete within project (potentially destructive)
  if (operation === "delete" && within && !excludedDir) {
    return {
      risk: "high",
      reason: `delete operation on project file: ${filePath}`,
      secretRisk: false,
      destructive: true,
      outOfProject: false,
    }
  }

  // MEDIUM: write to project file (normal coding)
  if (operation === "write" && within && !excludedDir) {
    return {
      risk: "medium",
      reason: `write to project file: ${filePath}`,
      secretRisk: false,
      destructive: false,
      outOfProject: false,
    }
  }

  // MEDIUM: read outside project
  if (operation === "read" && !within && !excludedDir) {
    return {
      risk: "medium",
      reason: `read file outside project boundary: ${filePath}`,
      secretRisk: false,
      destructive: false,
      outOfProject: true,
    }
  }

  // LOW: read within project, or operations on excluded dirs
  return {
    risk: "low",
    reason: excludedDir
      ? `operation on excluded directory: ${filePath}`
      : `safe read within project: ${filePath}`,
    secretRisk: false,
    destructive: false,
    outOfProject: false,
  }
}

/**
 * Determine the permission action (allow/ask/deny) based on risk level
 * and whether this is the first request of this type.
 */
export function permissionActionForRisk(
  risk: RiskLevel,
  alreadyConfirmed: boolean,
): "allow" | "ask" | "deny" {
  switch (risk) {
    case "low":
      return "allow"
    case "medium":
      return alreadyConfirmed ? "allow" : "ask"
    case "high":
      return "ask"
  }
}

/**
 * Check if a path string references any excluded directory pattern.
 * Useful for tool-level filtering before creating permission requests.
 */
export function touchesExcludedDir(input: string): boolean {
  return EXCLUDED_DIRS.some((dir) => {
    const pattern = new RegExp(`(^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|/)`)
    return pattern.test(input)
  })
}

/**
 * Full classification for a permission request covering both command
 * context (shell tool) and file context (read/write tools).
 */
export function classifyPermissionRequest(input: {
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  projectRoot?: string
  cwd?: string
}): ClassificationResult {
  const { permission, patterns, metadata, projectRoot, cwd } = input

  // Shell commands
  if (permission === "shell" || permission === "bash") {
    const cmd = patterns.join(" ") || String(metadata?.command ?? "")
    return classifyCommand({ command: cmd, cwd, projectRoot })
  }

  // File reads
  if (permission === "file_read" || permission === "read") {
    const filePath = patterns[0] ?? ""
    return classifyFileOp({ path: filePath, operation: "read", projectRoot })
  }

  // File writes
  if (permission === "file_write" || permission === "write" || permission === "edit") {
    const filePath = patterns[0] ?? ""
    return classifyFileOp({ path: filePath, operation: "write", projectRoot })
  }

  // File delete
  if (permission === "file_delete" || permission === "delete") {
    const filePath = patterns[0] ?? ""
    return classifyFileOp({ path: filePath, operation: "delete", projectRoot })
  }

  // External network directory access
  if (permission === "external_directory") {
    return {
      risk: "medium",
      reason: "external directory access requested",
      secretRisk: false,
      destructive: false,
      outOfProject: true,
    }
  }

  // Default: medium risk for unknown permission types
  return {
    risk: "medium",
    reason: `unrecognized permission type: ${permission}`,
    secretRisk: false,
    destructive: false,
    outOfProject: false,
  }
}
