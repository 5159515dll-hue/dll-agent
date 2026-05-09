/**
 * dll-agent lsp-strategy tests
 */
import { describe, it, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  detectProjectLanguage,
  computePrewarmPlan,
  isLspExcludedPath,
  lspNamesForLanguage,
  DEFAULT_LSP_STRATEGY,
} from "../../src/dll-agent/lsp-strategy"
import {
  buildLspPrewarmTargets,
  computeLspBridgePlan,
  lspDoctorCheck,
  runLspPrewarmRuntime,
} from "../../src/dll-agent/lsp-bridge"

function withTempProject(files: Record<string, string>, fn: (dir: string) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dll-agent-lsp-"))
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

describe("lsp-strategy", () => {
  describe("detectProjectLanguage", () => {
    it("detects typescript from package.json", () => {
      // Uses the current repo which has package.json
      const lang = detectProjectLanguage(
        "/Users/dailulu/projects/dll-agent-opencode",
      )
      expect(lang).toBe("typescript")
    })

    it("returns unknown for empty/nonexistent dir", () => {
      const lang = detectProjectLanguage("/tmp/nonexistent-project-xyz")
      expect(lang).toBe("unknown")
    })
  })

  describe("computePrewarmPlan", () => {
    it("prewarms only main language in project-main mode", () => {
      const plan = computePrewarmPlan(
        "/Users/dailulu/projects/dll-agent-opencode",
        DEFAULT_LSP_STRATEGY,
      )
      expect(plan.prewarm).toContain("typescript")
      expect(plan.prewarm.length).toBeLessThanOrEqual(3)
    })

    it("returns empty prewarm in lazy mode", () => {
      const plan = computePrewarmPlan(
        "/Users/dailulu/projects/dll-agent-opencode",
        { ...DEFAULT_LSP_STRATEGY, mode: "lazy" },
      )
      expect(plan.prewarm).toEqual([])
      expect(plan.lazy.length).toBeGreaterThanOrEqual(0)
    })

    it("keeps auxiliary languages lazy in project-main mode", async () => {
      await withTempProject({
        "package.json": "{}",
        "src/index.ts": "export const x = 1",
        "pyproject.toml": "[project]\nname='x'",
        "tools/check.py": "print('ok')",
      }, (dir) => {
        const plan = computePrewarmPlan(dir, DEFAULT_LSP_STRATEGY)
        expect(plan.prewarm).toEqual(["typescript"])
        expect(plan.lazy).toContain("python")
      })
    })
  })

  describe("LSP bridge runtime", () => {
    it("builds bounded project-main targets and excludes generated/vendor dirs", async () => {
      await withTempProject({
        "package.json": "{}",
        "src/a.ts": "export const a = 1",
        "src/b.ts": "export const b = 1",
        "node_modules/pkg/index.ts": "export const vendor = 1",
        "dist/bundle.ts": "export const dist = 1",
        ".venv/lib/site-packages/foo.py": "print('vendor')",
      }, (dir) => {
        const plan = computeLspBridgePlan(dir, {
          maxPrewarmFilesPerLanguage: 10,
          maxTotalPrewarmFiles: 1,
        })
        const targets = buildLspPrewarmTargets(plan)
        expect(targets).toHaveLength(1)
        expect(targets[0].language).toBe("typescript")
        expect(targets[0].file).toContain("src")
        expect(targets.some((target) => isLspExcludedPath(target.file))).toBe(false)
      })
    })

    it("runtime touches only available main-language targets", async () => {
      await withTempProject({
        "package.json": "{}",
        "src/a.ts": "export const a = 1",
        "src/b.ts": "export const b = 1",
        "tools/check.py": "print('lazy')",
        "pyproject.toml": "[project]\nname='lazy'",
      }, async (dir) => {
        const touched: string[] = []
        const result = await runLspPrewarmRuntime({
          projectRoot: dir,
          adapter: {
            hasClients: (file) => file.endsWith(".ts"),
            touchFile: (file) => {
              touched.push(file)
            },
          },
        })
        expect(result.plan.prewarm).toEqual(["typescript"])
        expect(result.plan.lazy).toContain("python")
        expect(touched.length).toBeGreaterThan(0)
        expect(touched.every((file) => file.endsWith(".ts"))).toBe(true)
        expect(touched.some((file) => file.endsWith(".py"))).toBe(false)
      })
    })

    it("runtime skips targets without available LSP clients", async () => {
      await withTempProject({
        "package.json": "{}",
        "src/a.ts": "export const a = 1",
      }, async (dir) => {
        const result = await runLspPrewarmRuntime({
          projectRoot: dir,
          adapter: {
            hasClients: () => false,
            touchFile: () => {
              throw new Error("should not touch unavailable LSP")
            },
          },
        })
        expect(result.touched).toEqual([])
        expect(result.skipped.length).toBeGreaterThan(0)
        expect(result.failed).toEqual([])
      })
    })

    it("doctor reports bounded project-main prewarm metadata", async () => {
      await withTempProject({
        "package.json": "{}",
        "src/a.ts": "export const a = 1",
      }, (dir) => {
        const result = lspDoctorCheck(dir)
        expect(result.mode).toBe("project-main")
        expect(result.prewarmCount).toBe(1)
        expect(result.targetCount).toBeGreaterThan(0)
        expect(result.excludedTargetCount).toBe(0)
      })
    })
  })

  describe("isLspExcludedPath", () => {
    it("flags node_modules", () => {
      expect(isLspExcludedPath("node_modules/react/index.js")).toBe(true)
    })

    it("flags .git", () => {
      expect(isLspExcludedPath(".git/config")).toBe(true)
    })

    it("flags dist", () => {
      expect(isLspExcludedPath("dist/bundle.js")).toBe(true)
    })

    it("flags .venv", () => {
      expect(isLspExcludedPath(".venv/lib/python3/site-packages/foo.py")).toBe(true)
    })

    it("flags __pycache__", () => {
      expect(isLspExcludedPath("__pycache__/module.cpython-311.pyc")).toBe(true)
    })

    it("does not flag normal source", () => {
      expect(isLspExcludedPath("src/components/Foo.tsx")).toBe(false)
    })
  })

  describe("lspNamesForLanguage", () => {
    it("returns typescript LSP names", () => {
      const names = lspNamesForLanguage("typescript")
      expect(names).toContain("typescript")
    })

    it("returns rust-analyzer for rust", () => {
      const names = lspNamesForLanguage("rust")
      expect(names).toContain("rust-analyzer")
    })

    it("returns empty for unknown", () => {
      expect(lspNamesForLanguage("unknown")).toEqual([])
    })
  })
})
