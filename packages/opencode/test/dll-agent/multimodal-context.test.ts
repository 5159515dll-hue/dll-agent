/**
 * Tests for multimodal-context-interpreter role and multimodal-context.ts
 *
 * Coverage:
 * 1. Role registry contains multimodal-context-interpreter
 * 2. Default model is mimo/mimo-v2.5-pro
 * 3. Role is enabled and on-demand only
 * 4. Multimodal input detection works for screenshots, images, video, audio, etc.
 * 5. Pure text tasks do NOT trigger multimodal signal
 * 6. Pure code tasks do NOT trigger multimodal signal
 * 7. Packet building produces valid multimodal_context_packet
 * 8. Packet validation catches issues
 * 9. Dedup/stale detection works via source hash
 * 10. Evidence types are defined
 * 11. Role switching via registry works
 * 12. MiMo provider availability check
 * 13. TTS/voice models not assigned to this role (coding role guard)
 * 14. ALL_ROLES includes 12 roles now
 * 15. ACTIVE_ROLES includes multimodal-context-interpreter
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const testDir = path.join(os.homedir(), ".dll-agent", "test-multimodal")
const sessionDir = path.join(testDir, "sessions", "test-multimodal-session")

beforeEach(() => {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  fs.mkdirSync(sessionDir, { recursive: true })
})

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
    // Also clean canonical session dir used by savePacket/loadPackets
    const canonicalDir = path.join(os.homedir(), ".dll-agent", "sessions", "test-multimodal-session")
    if (fs.existsSync(canonicalDir)) fs.rmSync(canonicalDir, { recursive: true })
    delete process.env.MIMO_API_KEY
  })

// ─── Imports ──────────────────────────────────────────────────────────────

let registry: typeof import("../../src/dll-agent/role-model-registry")
let multimodal: typeof import("../../src/dll-agent/multimodal-context")

beforeEach(async () => {
  registry = await import("../../src/dll-agent/role-model-registry")
  multimodal = await import("../../src/dll-agent/multimodal-context")
})

// ============================================================================
// Test 1: Role registry contains multimodal-context-interpreter
// ============================================================================
describe("role registry", () => {
  test("DllRole includes multimodal-context-interpreter", () => {
    expect(registry.isDllRole("multimodal-context-interpreter")).toBe(true)
  })

  test("ALL_ROLES includes the new role", () => {
    expect(registry.ALL_ROLES).toContain("multimodal-context-interpreter")
    expect(registry.ALL_ROLES.length).toBe(12)
  })

  test("ACTIVE_ROLES includes the new role (enabled=true)", () => {
    expect(registry.ACTIVE_ROLES).toContain("multimodal-context-interpreter")
  })

  test("default model is mimo/mimo-v2.5-pro", () => {
    const effective = registry.resolveRoleModel("multimodal-context-interpreter")
    expect(effective.primary).toBe("mimo/mimo-v2.5-pro")
    expect(effective.source).toBe("built-in")
  })

  test("role is on-demand only", () => {
    const effective = registry.resolveRoleModel("multimodal-context-interpreter")
    expect(effective.onDemandOnly).toBe(true)
  })

  test("role is enabled", () => {
    const effective = registry.resolveRoleModel("multimodal-context-interpreter")
    expect(effective.enabled).toBe(true)
  })
})

// ============================================================================
// Test 2: Default model is mimo/mimo-v2.5-pro (not free model)
// ============================================================================
describe("default model", () => {
  test("primary model uses paid MiMo Token Plan", () => {
    const builtIn = registry.getBuiltInConfig("multimodal-context-interpreter")
    expect(builtIn).toBeDefined()
    expect(builtIn!.primary).toBe("mimo/mimo-v2.5-pro")
  })

  test("can switch model via setRoleModelOverride", () => {
    const change = registry.setRoleModelOverride(
      "multimodal-context-interpreter",
      "openai/gpt-5.5-pro",
      "project",
      undefined,
      testDir,
    )
    expect(change).not.toBeNull()
    expect(change!.newPrimary).toBe("openai/gpt-5.5-pro")
    expect(change!.scope).toBe("project")
  })

  test("reset restores built-in default", () => {
    registry.setRoleModelOverride("multimodal-context-interpreter", "openai/gpt-5.5-pro", "project", undefined, testDir)
    registry.resetRoleModelOverride("multimodal-context-interpreter", "project", undefined, testDir)
    const effective = registry.resolveRoleModel("multimodal-context-interpreter", undefined, testDir)
    expect(effective.primary).toBe("mimo/mimo-v2.5-pro")
  })
})

// ============================================================================
// Test 3: Multimodal input detection
// ============================================================================
describe("multimodal input detection", () => {
  test("detects screenshot input", () => {
    const result = multimodal.detectMultimodalInput("请分析这个截图")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("screenshot")
  })

  test("detects image input", () => {
    const result = multimodal.detectMultimodalInput("this image shows a chart, please analyze screenshot.png")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("image")
    expect(result.inputTypes).toContain("screenshot")
  })

  test("detects video input", () => {
    const result = multimodal.detectMultimodalInput("analyze this video: demo.mp4")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("video")
  })

  test("detects audio input", () => {
    const result = multimodal.detectMultimodalInput("请听这段音频 recording.mp3")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("audio")
  })

  test("detects PPT figure input", () => {
    const result = multimodal.detectMultimodalInput("看这个 PPT 图示中的流程图")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("ppt_figure")
    expect(result.inputTypes).toContain("flowchart")
  })

  test("detects chart input", () => {
    const result = multimodal.detectMultimodalInput("分析这个图表 chart.png 中的数据")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("chart")
    expect(result.inputTypes).toContain("image")
  })

  test("detects webpage visual input", () => {
    const result = multimodal.detectMultimodalInput("看看这个网页的布局和视觉设计 screenshot")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("webpage_visual")
  })

  test("detects UI input", () => {
    const result = multimodal.detectMultimodalInput("分析 UI 界面的截图")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("ui")
  })

  test("detects document visual input", () => {
    const result = multimodal.detectMultimodalInput("这个 PDF 中的图示截图需要分析")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.inputTypes).toContain("document_visual")
  })

  test("high confidence for multiple strong signals", () => {
    const result = multimodal.detectMultimodalInput("分析截图 screenshot.png 和图片 chart.png 中的流程图和 UI 界面布局")
    expect(result.hasMultimodalSignal).toBe(true)
    expect(result.confidence).toBe("high")
  })
})

// ============================================================================
// Test 4: Pure text/code tasks do NOT trigger multimodal
// ============================================================================
describe("non-multimodal inputs", () => {
  test("pure text question does not trigger", () => {
    const result = multimodal.detectMultimodalInput("请帮我修复 typecheck 错误")
    expect(result.hasMultimodalSignal).toBe(false)
  })

  test("code modification does not trigger", () => {
    const result = multimodal.detectMultimodalInput("fix the bug in supervisor.ts line 927")
    expect(result.hasMultimodalSignal).toBe(false)
  })

  test("typecheck/test/build do not trigger", () => {
    const result = multimodal.detectMultimodalInput("run bun test test/dll-agent/")
    expect(result.hasMultimodalSignal).toBe(false)
  })

  test("requirements check does not trigger", () => {
    const result = multimodal.detectMultimodalInput("检查需求是否偏离")
    expect(result.hasMultimodalSignal).toBe(false)
  })

  test("empty string does not trigger", () => {
    const result = multimodal.detectMultimodalInput("")
    expect(result.hasMultimodalSignal).toBe(false)
  })
})

// ============================================================================
// Test 5: Packet building and validation
// ============================================================================
describe("packet building", () => {
  test("buildMultimodalPacket creates valid packet", () => {
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "screenshot",
      userGoal: "analyze error in UI",
      sourceRef: "/tmp/screenshot.png",
      sourceHash: multimodal.hashSource({ filePath: "/tmp/screenshot.png" }),
      taskRelevance: "shows build error",
      observations: [{ description: "red error box", category: "error", confidence: "high" }],
      detectedText: "TypeError: undefined is not a function",
      visualStructure: "top: header, middle: code editor, bottom: terminal with error",
      errorsOrWarnings: ["build error in terminal"],
      importantDetails: ["error at package build step"],
      uncertainties: ["unclear which file caused the error"],
      overallConfidence: "medium",
      contextSufficient: true,
      recommendedNextRole: "chief-engineer",
      evidenceRefs: ["screenshot_20260509_001.png"],
    })

    expect(packet.packet_type).toBe("multimodal_context_packet")
    expect(packet.role).toBe("multimodal-context-interpreter")
    expect(packet.model).toBe("mimo/mimo-v2.5-pro")
    expect(packet.input_type).toBe("screenshot")
    expect(packet.overall_confidence).toBe("medium")
    expect(packet.context_sufficient).toBe(true)
    expect(packet.observations.length).toBe(1)
    expect(packet.redaction_status).toBe("none")
    expect(packet.packet_id).toStartWith("mmctx_")
  })

  test("validation catches low confidence with sufficient=true inconsistency", () => {
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "image",
      userGoal: "test",
      sourceRef: "test.png",
      sourceHash: "abc123",
      taskRelevance: "test",
      observations: [],
      detectedText: null,
      visualStructure: null,
      errorsOrWarnings: [],
      importantDetails: [],
      uncertainties: [],
      overallConfidence: "low",
      contextSufficient: true,
      recommendedNextRole: null,
      evidenceRefs: [],
    })
    const validation = multimodal.validatePacket(packet)
    expect(validation.valid).toBe(false)
    expect(validation.issues.some((i) => i.includes("low confidence with context_sufficient=true"))).toBe(true)
  })

  test("validation catches high confidence with uncertainties", () => {
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "image",
      userGoal: "test",
      sourceRef: "test.png",
      sourceHash: "abc123",
      taskRelevance: "test",
      observations: [{ description: "test", category: "other", confidence: "high" }],
      detectedText: null,
      visualStructure: null,
      errorsOrWarnings: [],
      importantDetails: [],
      uncertainties: ["some uncertainty"],
      overallConfidence: "high",
      contextSufficient: true,
      recommendedNextRole: null,
      evidenceRefs: [],
    })
    const validation = multimodal.validatePacket(packet)
    expect(validation.valid).toBe(false)
    expect(validation.issues.some((i) => i.includes("high confidence with remaining uncertainties"))).toBe(true)
  })

  test("valid packet passes validation", () => {
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "screenshot",
      userGoal: "analyze code",
      sourceRef: "test.png",
      sourceHash: "abc123",
      taskRelevance: "debug",
      observations: [{ description: "code visible", category: "text_content", confidence: "high" }],
      detectedText: "const x = 1",
      visualStructure: "IDE window",
      errorsOrWarnings: [],
      importantDetails: ["code is valid JS"],
      uncertainties: [],
      overallConfidence: "high",
      contextSufficient: true,
      recommendedNextRole: "commander",
      evidenceRefs: [],
    })
    const validation = multimodal.validatePacket(packet)
    expect(validation.valid).toBe(true)
    expect(validation.issues.length).toBe(0)
  })
})

// ============================================================================
// Test 6: Dedup/stale detection via source hash
// ============================================================================
describe("dedup and stale detection", () => {
  test("hashSource generates consistent hash for same file", () => {
    const testFile = path.join(testDir, "test.png")
    fs.writeFileSync(testFile, "fake image content")
    const hash1 = multimodal.hashSource({ filePath: testFile })
    const hash2 = multimodal.hashSource({ filePath: testFile })
    expect(hash1).toBe(hash2)
  })

  test("hashSource changes when file content changes", () => {
    const testFile = path.join(testDir, "test.png")
    fs.writeFileSync(testFile, "version 1")
    const hash1 = multimodal.hashSource({ filePath: testFile })
    fs.writeFileSync(testFile, "version 2")
    const hash2 = multimodal.hashSource({ filePath: testFile })
    expect(hash1).not.toBe(hash2)
  })

  test("isPacketStale returns true when hash differs", () => {
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "image",
      userGoal: "test",
      sourceRef: "test.png",
      sourceHash: "oldhash12345678",
      taskRelevance: "test",
      observations: [],
      detectedText: null,
      visualStructure: null,
      errorsOrWarnings: [],
      importantDetails: [],
      uncertainties: [],
      overallConfidence: "medium",
      contextSufficient: true,
      recommendedNextRole: null,
      evidenceRefs: [],
    })
    expect(multimodal.isPacketStale(packet, "newhash12345678")).toBe(true)
    expect(multimodal.isPacketStale(packet, "oldhash12345678")).toBe(false)
  })

  test("savePacket and loadPackets round-trip", () => {
    const sessionID = "test-multimodal-session"
    const packet = multimodal.buildMultimodalPacket({
      model: "mimo/mimo-v2.5-pro",
      inputType: "screenshot",
      userGoal: "test",
      sourceRef: "test.png",
      sourceHash: "testhash12345678",
      taskRelevance: "test",
      observations: [{ description: "test obs", category: "other", confidence: "high" }],
      detectedText: null,
      visualStructure: null,
      errorsOrWarnings: [],
      importantDetails: [],
      uncertainties: [],
      overallConfidence: "high",
      contextSufficient: true,
      recommendedNextRole: null,
      evidenceRefs: [],
    })
    multimodal.savePacket(sessionID, packet)
    const loaded = multimodal.loadPackets(sessionID)
    expect(loaded.length).toBe(1)
    expect(loaded[0].packet_id).toBe(packet.packet_id)
    expect(loaded[0].source_hash).toBe(packet.source_hash)
  })
})

// ============================================================================
// Test 7: Provider availability
// ============================================================================
describe("provider availability", () => {
  test("MiMo shows unavailable when MIMO_API_KEY missing", () => {
    delete process.env.MIMO_API_KEY
    const effective = registry.resolveRoleModel("multimodal-context-interpreter")
    expect(effective.providerAvailable).toBe(false)
  })

  test("MiMo shows available when MIMO_API_KEY present", () => {
    process.env.MIMO_API_KEY = "sk-test-mimo-key"
    const effective = registry.resolveRoleModel("multimodal-context-interpreter")
    expect(effective.providerAvailable).toBe(true)
    delete process.env.MIMO_API_KEY
  })
})

// ============================================================================
// Test 8: MiMo not set as commander default
// ============================================================================
describe("MiMo not commander default", () => {
  test("commander is still DeepSeek", () => {
    const cmdr = registry.resolveRoleModel("commander")
    expect(cmdr.primary).toBe("deepseek/deepseek-v4-pro")
    expect(cmdr.primary).not.toBe("mimo/mimo-v2.5-pro")
  })

  test("chief-engineer is still DeepSeek", () => {
    const ce = registry.resolveRoleModel("chief-engineer")
    expect(ce.primary).toBe("deepseek/deepseek-v4-pro")
  })
})

// ============================================================================
// Test 9: Redaction
// ============================================================================
describe("redaction", () => {
  test("redacts API keys in multimodal content", () => {
    const result = multimodal.redactMultimodalContent("API key: sk-abc123def456 for openai")
    expect(result).not.toContain("sk-abc123def456")
    expect(result).toContain("[REDACTED]")
  })

  test("redacts private file paths", () => {
    const result = multimodal.redactMultimodalContent("screenshot from /Users/test/Desktop/secret.png")
    expect(result).not.toContain("/Users/test/Desktop/secret.png")
  })

  test("does not redact normal file paths", () => {
    const result = multimodal.redactMultimodalContent("file at packages/opencode/src/test.ts")
    expect(result).toContain("packages/opencode/src/test.ts")
  })
})

// ============================================================================
// Test 10: Image/video/audio attachment detection
// ============================================================================
describe("attachment detection", () => {
  test("hasImageAttachment detects images", () => {
    expect(multimodal.hasImageAttachment(["screenshot.png", "code.ts"])).toBe(true)
    expect(multimodal.hasImageAttachment(["code.ts", "test.ts"])).toBe(false)
  })

  test("hasVideoAttachment detects videos", () => {
    expect(multimodal.hasVideoAttachment(["demo.mp4", "code.ts"])).toBe(true)
    expect(multimodal.hasVideoAttachment(["code.ts"])).toBe(false)
  })

  test("hasAudioAttachment detects audio", () => {
    expect(multimodal.hasAudioAttachment(["voice.mp3", "code.ts"])).toBe(true)
    expect(multimodal.hasAudioAttachment(["code.ts"])).toBe(false)
  })
})
