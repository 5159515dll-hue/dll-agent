/**
 * Small gate-composition helpers for the OpenCode session loop.
 *
 * Gate implementations stay in gates.ts/continuation-gate.ts. This module only
 * composes already-computed decisions so prompt.ts does not hand-roll string
 * merging for each finalization path.
 */

import type { CapabilityOrchestrationResult } from "./capability-orchestrator"
import type { EvidenceGateResult } from "./interfaces"

export interface GateBlock {
  reason: string
  hint: string | null
}

export function appendGateBlock(result: EvidenceGateResult, block: GateBlock): EvidenceGateResult {
  return {
    ...result,
    passed: false,
    block_reason: result.block_reason ? `${result.block_reason}; ${block.reason}` : block.reason,
    synthetic_hint: [result.synthetic_hint, block.hint].filter(Boolean).join("\n") || null,
  }
}

export function buildDedupGateBlock(input: { packetId?: string; hint?: string | null }): GateBlock {
  return {
    reason: `dedup hard-block: existing verified result ${input.packetId ?? "unknown"} must be reused or redo justified`,
    hint: input.hint ?? null,
  }
}

export function buildCapabilityGateBlock(
  runtime: CapabilityOrchestrationResult | undefined,
  isCompletionClaim: boolean,
): GateBlock | null {
  if (!runtime || !isCompletionClaim) return null
  const blocks = [
    ...runtime.unresolvedGaps.map((gap) => `missing capability: ${gap.tag}`),
    ...runtime.blockedReasons,
  ]
  if (blocks.length === 0) return null
  const reason = `capability requirements unresolved: ${blocks.slice(0, 4).join("; ")}`
  return {
    reason,
    hint: [
      "<dll-agent-capability-gate>",
      reason,
      "Resolve, verify, or explicitly disclose these capability gaps before claiming completion.",
      "</dll-agent-capability-gate>",
    ].join("\n"),
  }
}

export function capabilityGateEvidence(runtime: CapabilityOrchestrationResult | undefined) {
  if (!runtime) return null
  return {
    fingerprint: runtime.fingerprint,
    blocks: [
      ...runtime.unresolvedGaps.map((gap) => `missing capability: ${gap.tag}`),
      ...runtime.blockedReasons,
    ],
  }
}
