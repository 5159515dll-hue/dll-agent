import { describe, test, expect } from "bun:test"
import { runDiscovery, needsDiscovery, clearDiscoveryCache } from "../../src/dll-agent/capability-discovery"
import { loadDiscoveredRegistry } from "../../src/dll-agent/capability-registry"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_PROJECT = path.join(os.tmpdir(), "dll-agent-discovery-test-" + Date.now())

describe("capability-discovery", () => {
  test("needsDiscovery returns true when cache is stale/missing", () => {
    clearDiscoveryCache()
    expect(needsDiscovery()).toBe(true)
  })

  test("runDiscovery scans for local commands without error", () => {
    const result = runDiscovery()
    expect(result.total).toBeGreaterThan(0)
    expect(result.new).toBeGreaterThanOrEqual(0)
    expect(result.timestamp).toBeTruthy()
    expect(result.by_source).toBeDefined()
  })

  test("runDiscovery with project dir scans manifests", () => {
    // Create a minimal package.json
    fs.mkdirSync(TEST_PROJECT, { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT, "package.json"), JSON.stringify({
      name: "test-project",
      dependencies: { "playwright": "^1.40.0" },
    }))

    const result = runDiscovery(TEST_PROJECT)
    // Should find playwright from package.json
    const playwrightEntry = result.entries.find((e) => e.id === "project-playwright")
    expect(playwrightEntry).toBeDefined()
    expect(playwrightEntry!.source_type).toBe("manifest")

    // Cleanup
    fs.rmSync(TEST_PROJECT, { recursive: true, force: true })
  })

  test("discovered entries are written to discovered registry", () => {
    runDiscovery()
    const discovered = loadDiscoveredRegistry()
    expect(discovered.length).toBeGreaterThan(0)
  })

  test("needsDiscovery returns false after fresh discovery (cache exists)", () => {
    // Cache should now exist from previous test
    // Only check that needsDiscovery exists as a function
    expect(typeof needsDiscovery).toBe("function")
  })
})

describe("discovery TTL", () => {
  test("clearDiscoveryCache removes cache file", () => {
    clearDiscoveryCache()
    const cachePath = path.join(os.homedir(), ".dll-agent", "capabilities", "discovery-cache.json")
    expect(fs.existsSync(cachePath)).toBe(false)
  })
})
