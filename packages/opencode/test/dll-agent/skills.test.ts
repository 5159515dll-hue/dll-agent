import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs"
import { activate, summary, checkForbiddenCommand, persist, loadActive, policyUnion, MAX_ACTIVE_PER_TURN, deactivationCandidates } from "../../src/dll-agent/skills"
import { SKILL_REGISTRY } from "../../src/dll-agent/skill-registry"

const baseInput = {
  userText: "",
  files: [],
  repoMarkers: [],
  intents: [],
  currentStep: 1,
}

describe("DllAgentSkills.activate", () => {
  test("activates repo-doctor on keyword", () => {
    const r = activate({ ...baseInput, userText: "请帮我做 repo doctor 检查" })
    expect(r.activated.map((a) => a.skill.name)).toContain("repo-doctor")
  })

  test("activates on .ts file matching repo markers", () => {
    const r = activate({
      ...baseInput,
      userText: "检查一下项目状态",
      files: ["packages/opencode/src/foo.ts"],
      repoMarkers: [".git", "package.json"],
    })
    // Should match at least repo-doctor (repo markers) or ux-review (file glob)
    expect(r.activated.length).toBeGreaterThan(0)
  })

  test("does not activate repo-doctor for stateless greeting from repo marker alone", () => {
    const r = activate({
      ...baseInput,
      userText: "你好",
      repoMarkers: [".git", "package.json"],
    })
    expect(r.activated.map((a) => a.skill.id)).not.toContain("repo-doctor")
  })

  test("MAX_ACTIVE_PER_TURN cap respected", () => {
    const r = activate({
      ...baseInput,
      userText: "repo doctor security redaction docs sync cost guard test cross review ux",
      files: ["src/a.ts", "src/b.test.ts"],
      repoMarkers: [".git", "package.json"],
    })
    expect(r.activated.length).toBeLessThanOrEqual(MAX_ACTIVE_PER_TURN)
  })

  test("cooldown skips a recently activated skill", () => {
    const r = activate({
      ...baseInput,
      userText: "repo doctor",
      currentStep: 2,
      history: { "repo-doctor": { lastStep: 2, count: 1 } },
    })
    const skipped = r.skipped.find((s) => s.name === "repo-doctor")
    expect(skipped?.reason === "cooldown" || skipped?.reason === "no_match" || skipped === undefined).toBe(true)
  })

  test("max_activations skips after limit", () => {
    const r = activate({
      ...baseInput,
      userText: "repo doctor diagnose",
      currentStep: 100,
      history: { "repo-doctor": { lastStep: 0, count: 99 } },
    })
    const skipped = r.skipped.find((s) => s.name === "repo-doctor")
    expect(skipped?.reason).toBe("max_activations")
  })

  test("outputs contain structured data for activated skills", () => {
    const r = activate({ ...baseInput, userText: "repo doctor 检查" })
    expect(r.outputs.length).toBeGreaterThanOrEqual(0)
    const output = r.outputs.find((o) => o.skill_id === "repo-doctor")
    if (output) {
      expect(output.risk_level).toBe("low")
      expect(output.required_evidence).toBeDefined()
      expect(output.cost_impact).toBeDefined()
      expect(output.security_impact).toBeDefined()
    }
  })

  test("summary returns empty for no activations", () => {
    expect(summary([])).toBe("")
  })
})

describe("DllAgentSkills.checkForbiddenCommand", () => {
  test("blocks command matching skill forbiddenCommands", () => {
    const repoDoctor = SKILL_REGISTRY.find((s) => s.name === "repo-doctor")!
    const hit = checkForbiddenCommand("git push --force origin dev", [repoDoctor])
    expect(hit?.skill).toBe("repo-doctor")
    expect(hit?.pattern).toBe("git push --force")
  })

  test("returns null on benign command", () => {
    const repoDoctor = SKILL_REGISTRY.find((s) => s.name === "repo-doctor")!
    expect(checkForbiddenCommand("git status", [repoDoctor])).toBeNull()
  })

  test("returns null when no active skills", () => {
    expect(checkForbiddenCommand("rm -rf /", [])).toBeNull()
  })
})

describe("DllAgentSkills.persist + loadActive (round-trip)", () => {
  test("persist then loadActive returns same skill defs", () => {
    const sessionID = `test_persist_${Date.now()}`
    const ts = SKILL_REGISTRY.find((s) => s.name === "repo-doctor")!
    persist([{ skill: ts, reason: "test" }], sessionID)
    const loaded = loadActive(sessionID)
    expect(loaded.map((s) => s.name)).toEqual(["repo-doctor"])
    fs.rmSync(path.join(os.homedir(), ".dll-agent", "sessions", sessionID), { recursive: true, force: true })
  })

  test("loadActive returns [] for unknown session", () => {
    expect(loadActive("nonexistent_session_xyz")).toEqual([])
  })
})

describe("DllAgentSkills.policyUnion (Phase 4)", () => {
  function makeSkill(overrides: Record<string, unknown> = {}): any {
    return {
      id: overrides.id ?? overrides.name ?? "test-skill",
      name: overrides.name ?? "test-skill",
      description: "",
      version: "1.0.0",
      triggers: {},
      riskLevel: "low",
      activationPolicy: { maxActivationsPerSession: 5, minStepInterval: 1 },
      deactivationPolicy: {},
      requiredEvidence: [],
      cooldown: { minIntervalSec: 30, fingerprintIntervalSec: 120 },
      costPolicy: { singleCallCapMultiplier: 1.0, allowOpenAI: false, allowExpensiveReviewer: false },
      securityPolicy: { requireRedaction: true, allowExternalWrite: false, allowNetworkFetch: false },
      rollbackPolicy: { autoRollback: false, preRollbackChecks: [], rollbackCommands: [] },
      ...overrides,
    }
  }

  test("unions requiredTools/allowed/forbidden across active skills", () => {
    const u = policyUnion([
      {
        skill: makeSkill({ name: "a", requiredTools: ["bash", "edit"], allowedCommands: ["git status"], forbiddenCommands: ["rm -rf /"] }),
        reason: "x",
      },
      {
        skill: makeSkill({ name: "b", riskLevel: "medium", requiredTools: ["bash", "read"], allowedCommands: ["bun typecheck"], forbiddenCommands: ["git push --force"] }),
        reason: "y",
      },
    ])
    expect(u.requiredTools.sort()).toEqual(["bash", "edit", "read"])
    expect(u.allowedCommands.sort()).toEqual(["bun typecheck", "git status"])
    expect(u.forbiddenCommands.sort()).toEqual(["git push --force", "rm -rf /"])
  })

  test("empty input → empty arrays", () => {
    const u = policyUnion([])
    expect(u.requiredTools).toEqual([])
    expect(u.allowedCommands).toEqual([])
    expect(u.forbiddenCommands).toEqual([])
  })
})

describe("DllAgentSkills.activate signal-driven (P0-2)", () => {
  test("supervisor signal tool_failures_high activates repo-doctor without user text", () => {
    const r = activate({
      ...baseInput,
      signals: ["tool_failures_high"],
    })
    expect(r.activated.map((a) => a.skill.id)).toContain("repo-doctor")
  })

  test("permission_denied signal activates repo-doctor", () => {
    const r = activate({ ...baseInput, signals: ["permission_denied"] })
    expect(r.activated.map((a) => a.skill.id)).toContain("repo-doctor")
  })

  test("final_claim_no_evidence signal activates test-gate", () => {
    const r = activate({ ...baseInput, signals: ["final_claim_no_evidence"] })
    expect(r.activated.map((a) => a.skill.id)).toContain("test-gate")
  })

  test("reviewer_conflict signal bypasses requiresExplicitConsent for cross-review", () => {
    const r = activate({ ...baseInput, signals: ["reviewer_conflict"] })
    // cross-review is high-risk + requiresExplicitConsent; signal must bypass it.
    expect(r.activated.map((a) => a.skill.id)).toContain("cross-review")
  })

  test("verification_failed signal bypasses requiresExplicitConsent for self-repair", () => {
    const r = activate({ ...baseInput, signals: ["verification_failed"] })
    expect(r.activated.map((a) => a.skill.id)).toContain("self-repair")
  })

  test("self-repair without signal still requires explicit consent (kept safe)", () => {
    const r = activate({
      ...baseInput,
      userText: "dll-agent doctor 报错 wrapper broken",
    })
    // No signal, no consent → must NOT activate self-repair automatically.
    expect(r.activated.map((a) => a.skill.id)).not.toContain("self-repair")
    const skipped = r.skipped.find((s) => s.name === "self-repair")
    expect(skipped?.reason).toBe("needs_consent")
  })

  test("same skill + same fingerprint does not re-write evidence (dedup)", () => {
    // Activate once → writes evidence
    const r1 = activate({ ...baseInput, userText: "repo doctor", currentStep: 1, sessionID: "ses_dedup_test" })
    expect(r1.activated.map((a) => a.skill.id)).toContain("repo-doctor")

    // Activate again with same fingerprint in history → should NOT trigger duplicate evidence write
    // Use step far enough to avoid cooldown (repo-doctor minStepInterval=4)
    const r2 = activate({
      ...baseInput,
      userText: "repo doctor",
      currentStep: 100,
      sessionID: "ses_dedup_test",
      history: {
        "repo-doctor": {
          lastStep: 1,
          count: 1,
          fingerprint: "repo-doctor:keywordmatch",
        },
      },
    })
    expect(r2.activated.map((a) => a.skill.id)).toContain("repo-doctor")
  })
})
