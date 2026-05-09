/**
 * dll-agent actionable-error.ts
 *
 * Converts raw errors/failures into actionable next-step suggestions.
 * Output includes: what failed, why likely, next automatic action,
 * user action if required, evidence path.
 *
 * Principle: failures should never just say "it failed".
 * They must tell the user what to try next.
 */

// ─── Error Types ────────────────────────────────────────────────────────────

export type FailureCategory =
  | "typecheck_error"
  | "test_failure"
  | "tool_error"
  | "permission_denied"
  | "gate_blocked"
  | "reviewer_blocked"
  | "cost_exceeded"
  | "context_overflow"
  | "model_error"
  | "file_not_found"
  | "dependency_missing"
  | "config_error"
  | "provider_normalization_error"
  | "git_conflict"
  | "network_error"
  | "timeout"
  | "unknown"

export interface ActionableError {
  category: FailureCategory
  whatFailed: string
  whyLikely: string
  nextAutomaticAction: string | null
  userActionRequired: boolean
  userAction: string | null
  evidencePath: string | null
  recoveryAttempts: number
  maxRecoveryAttempts: number
}

// ─── Classifiers ────────────────────────────────────────────────────────────

function classifyFromOutput(stderr: string): FailureCategory {
  const lower = stderr.toLowerCase()

  if (/tsgo|tsc|typecheck|\.ts\(\d+,\d+\): error ts\d+/i.test(lower)) return "typecheck_error"
  if (/test.*fail|assert.*fail|expect.*not|✗|✘|fail\b/i.test(lower)) return "test_failure"
  if (/permission denied|access denied|eacces|not allowed/i.test(lower)) return "permission_denied"
  if (/cannot find module|module not found|cannot resolve/i.test(lower)) return "dependency_missing"
  if (/provider.*reasoning_effort|reasoning_effort|max.*low.*medium.*high|literal_error/i.test(lower)) return "provider_normalization_error"
  if (/config.*invalid|json.*parse|yaml.*parse|toml.*parse|unexpected token.*json/i.test(lower)) return "config_error"
  if (/enoent|no such file|file not found/i.test(lower)) return "file_not_found"
  if (/merge conflict|conflict|automerge failed/i.test(lower)) return "git_conflict"
  if (/network|connection refused|econnrefused|dns|timeout|etimedout/i.test(lower)) return "network_error"
  if (/context.*(?:overflow|limit|too long|exceed)/i.test(lower)) return "context_overflow"
  if (/cost|budget|quota|rate.?limit/i.test(lower)) return "cost_exceeded"
  if (/gate.*(?:block|denied|insufficient)/i.test(lower)) return "gate_blocked"
  if (/reviewer.*(?:block|denied|insufficient)/i.test(lower)) return "reviewer_blocked"

  return "unknown"
}

// ─── Recovery Suggestions ───────────────────────────────────────────────────

const RECOVERY_STRATEGIES: Record<FailureCategory, {
  automaticAction: string | null
  userAction: string | null
  userActionRequired: boolean
}> = {
  typecheck_error: {
    automaticAction: "Read the type error, locate the incorrect type usage, apply minimal fix, rerun typecheck.",
    userAction: null,
    userActionRequired: false,
  },
  test_failure: {
    automaticAction: "Read test failure output, identify the failing assertion, fix the implementation (not the test), rerun tests.",
    userAction: null,
    userActionRequired: false,
  },
  tool_error: {
    automaticAction: "Check tool configuration and permissions. Try an alternative tool or fix the tool invocation.",
    userAction: null,
    userActionRequired: false,
  },
  permission_denied: {
    automaticAction: "Fall back to a lower-risk alternative that doesn't require the denied permission.",
    userAction: "Authorize the permission if safe, or provide an alternative approach.",
    userActionRequired: true,
  },
  gate_blocked: {
    automaticAction: "Run required verification commands (typecheck, tests, doctor) as actual tool calls, then re-submit completion claim.",
    userAction: null,
    userActionRequired: false,
  },
  reviewer_blocked: {
    automaticAction: "Address the reviewer's blocking findings: acknowledge, fix, or provide evidence-based rejection.",
    userAction: "If reviewer findings are unclear or conflicting, request clarification or role-cross.",
    userActionRequired: false,
  },
  cost_exceeded: {
    automaticAction: null,
    userAction: "Increase cost cap or approve overspend for this session.",
    userActionRequired: true,
  },
  context_overflow: {
    automaticAction: "Trigger long-context-archivist to compress and summarize context, preserving evidence refs.",
    userAction: null,
    userActionRequired: false,
  },
  model_error: {
    automaticAction: "Retry with fallback model or reduce context size.",
    userAction: null,
    userActionRequired: false,
  },
  file_not_found: {
    automaticAction: "Search for the file using glob patterns. If genuinely missing, create it or adjust the path.",
    userAction: null,
    userActionRequired: false,
  },
  dependency_missing: {
    automaticAction: "Run the appropriate package manager install command within the project directory.",
    userAction: "If the dependency requires system-level installation, run: brew install <package> or equivalent.",
    userActionRequired: false,
  },
  config_error: {
    automaticAction: "Read the config parse/validation error, apply the minimal local config fix, rerun the failed command.",
    userAction: null,
    userActionRequired: false,
  },
  provider_normalization_error: {
    automaticAction: "Normalize provider request options at the final request boundary, add a regression test, rerun provider mock/smoke.",
    userAction: null,
    userActionRequired: false,
  },
  git_conflict: {
    automaticAction: "Resolve merge conflicts by keeping the correct version. Use git status to see conflicted files.",
    userAction: null,
    userActionRequired: false,
  },
  network_error: {
    automaticAction: "Retry the network operation. If persistent, try alternative source or offline mode.",
    userAction: "Check network connectivity and firewall settings.",
    userActionRequired: false,
  },
  timeout: {
    automaticAction: "Increase timeout and retry, or split the operation into smaller chunks.",
    userAction: null,
    userActionRequired: false,
  },
  unknown: {
    automaticAction: "Extract failure fingerprint, collect relevant logs, attempt minimal diagnosis.",
    userAction: "Provide more context or check system logs.",
    userActionRequired: false,
  },
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildActionableError(params: {
  whatFailed: string
  stderr?: string
  recoveryAttempts?: number
  maxRecoveryAttempts?: number
  evidencePath?: string | null
}): ActionableError {
  const category = params.stderr ? classifyFromOutput(params.stderr) : "unknown"
  const strategy = RECOVERY_STRATEGIES[category]
  const recoveryAttempts = params.recoveryAttempts ?? 0
  const maxRecovery = params.maxRecoveryAttempts ?? 5

  return {
    category,
    whatFailed: params.whatFailed,
    whyLikely: category !== "unknown"
      ? `Classified as [${category}] based on error output patterns.`
      : "Unable to classify failure from error output. Manual diagnosis needed.",
    nextAutomaticAction: recoveryAttempts >= maxRecovery
      ? null
      : strategy.automaticAction,
    userActionRequired: strategy.userActionRequired || recoveryAttempts >= maxRecovery,
    userAction: recoveryAttempts >= maxRecovery
      ? `Maximum recovery attempts (${maxRecovery}) reached. Manual intervention required. ${strategy.userAction ?? "Review the evidence and provide direction."}`
      : strategy.userAction,
    evidencePath: params.evidencePath ?? null,
    recoveryAttempts,
    maxRecoveryAttempts: maxRecovery,
  }
}

/**
 * Format an actionable error for display.
 */
export function formatActionableError(err: ActionableError): string {
  const lines = [
    `[dll-agent failure: ${err.category}]`,
    `What failed: ${err.whatFailed}`,
    `Why likely: ${err.whyLikely}`,
    ``,
    `Recovery attempts: ${err.recoveryAttempts}/${err.maxRecoveryAttempts}`,
  ]

  if (err.nextAutomaticAction) {
    lines.push(`Next automatic action: ${err.nextAutomaticAction}`)
  } else {
    lines.push(`Automatic recovery exhausted.`)
  }

  if (err.userAction) {
    lines.push(``, `User action required: ${err.userAction}`)
  }

  if (err.evidencePath) {
    lines.push(``, `Evidence: ${err.evidencePath}`)
  }

  return lines.join("\n")
}

/**
 * Build a failure fingerprint for deduplication.
 */
export function buildFailureFingerprint(category: FailureCategory, stderr: string): string {
  // Extract key patterns for deduplication
  const normalized = stderr
    .replace(/\d+/g, "N")
    .replace(/([\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java))\b/gi, "FILE")
    .replace(/\/[^\s:,]+/g, "/PATH")
    .slice(0, 200)
  return `${category}:${normalized}`
}
