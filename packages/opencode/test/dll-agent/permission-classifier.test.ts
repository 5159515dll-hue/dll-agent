/**
 * dll-agent permission-classifier tests
 */
import { describe, it, expect } from "bun:test"
import {
  classifyCommand,
  classifyFileOp,
  classifyPermissionRequest,
  permissionActionForRisk,
  touchesExcludedDir,
} from "../../src/dll-agent/permission-classifier"

describe("classifyCommand", () => {
  it("classifies git status as low risk", () => {
    const result = classifyCommand({ command: "git status" })
    expect(result.risk).toBe("low")
    expect(result.secretRisk).toBe(false)
  })

  it("classifies bun typecheck as low risk", () => {
    const result = classifyCommand({ command: "bun run --cwd packages/opencode typecheck" })
    expect(result.risk).toBe("low")
  })

  it("classifies bun test as low risk", () => {
    const result = classifyCommand({ command: "bun test --cwd packages/opencode test/dll-agent/" })
    expect(result.risk).toBe("low")
  })

  it("classifies dll-agent doctor as low risk", () => {
    const result = classifyCommand({ command: "/Users/dailulu/.local/bin/dll-agent doctor" })
    expect(result.risk).toBe("low")
  })

  it("classifies npm install within project as low risk", () => {
    const result = classifyCommand({ command: "bun install", projectRoot: "/project" })
    expect(result.risk).toBe("low")
  })

  it("classifies rm -rf as high risk destructive", () => {
    const result = classifyCommand({ command: "rm -rf /tmp/test" })
    expect(result.risk).toBe("high")
    expect(result.destructive).toBe(true)
  })

  it("classifies git push as high risk remote publish", () => {
    const result = classifyCommand({ command: "git push origin main" })
    expect(result.risk).toBe("high")
  })

  it("classifies git push --force as high risk", () => {
    const result = classifyCommand({ command: "git push --force origin main" })
    expect(result.risk).toBe("high")
  })

  it("classifies sudo as high risk global modify", () => {
    const result = classifyCommand({ command: "sudo systemctl restart nginx" })
    expect(result.risk).toBe("high")
    expect(result.outOfProject).toBe(true)
  })

  it("classifies npm install -g as high risk global modify", () => {
    const result = classifyCommand({ command: "npm install -g typescript" })
    expect(result.risk).toBe("high")
  })

  it("classifies brew install as high risk global modify", () => {
    const result = classifyCommand({ command: "brew install node" })
    expect(result.risk).toBe("high")
  })

  it("classifies cat .env as high risk secret", () => {
    const result = classifyCommand({ command: "cat .env" })
    expect(result.risk).toBe("high")
    expect(result.secretRisk).toBe(true)
  })

  it("classifies npm publish as high risk remote publish", () => {
    const result = classifyCommand({ command: "npm publish" })
    expect(result.risk).toBe("high")
  })

  it("classifies gh pr create as high risk remote publish", () => {
    const result = classifyCommand({ command: "gh pr create --title 'fix'" })
    expect(result.risk).toBe("high")
  })

  it("classifies git commit as low risk safe write", () => {
    const result = classifyCommand({ command: "git commit -m 'fix'" })
    expect(result.risk).toBe("low")
  })

  it("classifies git add as low risk safe write", () => {
    const result = classifyCommand({ command: "git add src/foo.ts" })
    expect(result.risk).toBe("low")
  })

  it("classifies unknown command as medium risk", () => {
    const result = classifyCommand({ command: "some_unknown_tool --flag" })
    expect(result.risk).toBe("medium")
  })
})

describe("classifyFileOp", () => {
  it("classifies read within project as low risk", () => {
    const result = classifyFileOp({
      path: "/project/src/foo.ts",
      operation: "read",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("low")
  })

  it("classifies write within project as medium risk", () => {
    const result = classifyFileOp({
      path: "/project/src/foo.ts",
      operation: "write",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("medium")
  })

  it("classifies delete within project as high risk", () => {
    const result = classifyFileOp({
      path: "/project/src/foo.ts",
      operation: "delete",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("high")
    expect(result.destructive).toBe(true)
  })

  it("classifies .env write as high risk secret", () => {
    const result = classifyFileOp({
      path: "/project/.env",
      operation: "write",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("high")
    expect(result.secretRisk).toBe(true)
  })

  it("classifies .ssh/config as high risk secret", () => {
    const result = classifyFileOp({
      path: "/home/user/.ssh/config",
      operation: "read",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("high")
    expect(result.secretRisk).toBe(true)
  })

  it("classifies node_modules read as low risk excluded dir", () => {
    const result = classifyFileOp({
      path: "/project/node_modules/react/index.js",
      operation: "read",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("low")
  })

  it("classifies write outside project as high risk", () => {
    const result = classifyFileOp({
      path: "/etc/hosts",
      operation: "write",
      projectRoot: "/project",
    })
    expect(result.risk).toBe("high")
    expect(result.outOfProject).toBe(true)
  })
})

describe("classifyPermissionRequest", () => {
  it("classifies shell typecheck as low risk", () => {
    const result = classifyPermissionRequest({
      permission: "shell",
      patterns: ["bun", "typecheck"],
      projectRoot: "/project",
    })
    expect(result.risk).toBe("low")
  })

  it("classifies shell rm -rf as high risk", () => {
    const result = classifyPermissionRequest({
      permission: "shell",
      patterns: ["rm", "-rf", "dir/"],
    })
    expect(result.risk).toBe("high")
  })

  it("classifies file_read as low risk", () => {
    const result = classifyPermissionRequest({
      permission: "file_read",
      patterns: ["/project/src/foo.ts"],
      projectRoot: "/project",
    })
    expect(result.risk).toBe("low")
  })

  it("classifies file_write as medium risk", () => {
    const result = classifyPermissionRequest({
      permission: "file_write",
      patterns: ["/project/src/foo.ts"],
      projectRoot: "/project",
    })
    expect(result.risk).toBe("medium")
  })

  it("classifies external_directory as medium risk", () => {
    const result = classifyPermissionRequest({
      permission: "external_directory",
      patterns: ["/tmp"],
    })
    expect(result.risk).toBe("medium")
  })
})

describe("permissionActionForRisk", () => {
  it("returns allow for low risk", () => {
    expect(permissionActionForRisk("low", false)).toBe("allow")
  })

  it("returns ask for medium risk first time", () => {
    expect(permissionActionForRisk("medium", false)).toBe("ask")
  })

  it("returns allow for medium risk already confirmed", () => {
    expect(permissionActionForRisk("medium", true)).toBe("allow")
  })

  it("returns ask for high risk", () => {
    expect(permissionActionForRisk("high", false)).toBe("ask")
    expect(permissionActionForRisk("high", true)).toBe("ask")
  })
})

describe("touchesExcludedDir", () => {
  it("detects node_modules", () => {
    expect(touchesExcludedDir("node_modules/react/index.js")).toBe(true)
  })

  it("detects .git", () => {
    expect(touchesExcludedDir(".git/config")).toBe(true)
  })

  it("detects dist", () => {
    expect(touchesExcludedDir("dist/bundle.js")).toBe(true)
  })

  it("does not flag normal paths", () => {
    expect(touchesExcludedDir("src/components/Foo.tsx")).toBe(false)
  })
})
