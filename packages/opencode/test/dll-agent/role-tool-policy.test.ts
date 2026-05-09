import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { classifyRoleToolRequest, doctorCheckRoleToolPolicy, permissionConfigForRole, roleToolPolicyFor } from "../../src/dll-agent/role-tool-policy"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"
import { WithInstance } from "../../src/project/with-instance"

function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  delete process.env.DLL_AGENT_ENABLED
  delete process.env.DLL_AGENT_ROLE_ROSTER
  delete process.env.DLL_AGENT_EVIDENCE_FILE
  await disposeAllInstances()
})

describe("role-tool-policy", () => {
  it("keeps commander, chief-engineer, and executor writable", () => {
    for (const role of ["commander", "chief-engineer", "executor"] as const) {
      const policy = roleToolPolicyFor(role)
      const config = permissionConfigForRole(role)
      expect(policy.mode).toBe("writable")
      expect(config["*"]).toBe("allow")
      expect(config.bash).toBeUndefined()
      expect(config.edit).toBeUndefined()
    }
  })

  it("makes reviewers read-only by denying mutating tools", () => {
    const reviewers = [
      "requirements-inspector",
      "long-context-archivist",
      "task-completion-archivist",
      "final-auditor",
      "role-cross",
      "multimodal-context-interpreter",
    ] as const
    for (const role of reviewers) {
      const config = permissionConfigForRole(role)
      expect(roleToolPolicyFor(role).mode).toBe("read_only")
      expect(config.read).toBe("allow")
      expect(config.bash).toBe("deny")
      expect(config.edit).toBe("deny")
      expect(config.write).toBe("deny")
      expect(config.patch).toBe("deny")
      expect(config.task).toBe("deny")
      expect(config.todowrite).toBe("deny")
    }
  })

  it("blocks reviewer and final-auditor write attempts at role policy level", () => {
    const reviewer = classifyRoleToolRequest({
      role: "requirements-inspector",
      permission: "edit",
      patterns: ["/project/src/app.ts"],
      writeEvidence: false,
    })
    const finalAuditor = classifyRoleToolRequest({
      role: "final-auditor",
      permission: "write",
      patterns: ["/project/src/app.ts"],
      writeEvidence: false,
    })
    expect(reviewer.action).toBe("deny")
    expect(finalAuditor.action).toBe("deny")
  })

  it("allows commander ordinary project writes but asks for high-risk commands", () => {
    const write = classifyRoleToolRequest({
      role: "commander",
      permission: "file_write",
      patterns: ["/project/src/app.ts"],
      projectRoot: "/project",
      writeEvidence: false,
    })
    const highRisk = classifyRoleToolRequest({
      role: "commander",
      permission: "bash",
      patterns: ["git push origin dev"],
      writeEvidence: false,
    })
    expect(write.action).toBe("allow")
    expect(highRisk.action).toBe("ask")
  })

  it("requires confirmation for high-risk tools and writes routing evidence", () => {
    const evidenceFile = path.join(os.tmpdir(), `dll-agent-role-tool-policy-${Date.now()}.jsonl`)
    process.env.DLL_AGENT_EVIDENCE_FILE = evidenceFile
    const decision = classifyRoleToolRequest({
      role: "commander",
      permission: "bash",
      patterns: ["rm -rf /tmp/dll-agent-policy-smoke"],
      sessionID: "role-policy-test",
    })
    expect(decision.action).toBe("ask")
    expect(decision.risk).toBe("high")
    const evidence = fs.readFileSync(evidenceFile, "utf8")
    expect(evidence).toContain("role_tool_policy.decision")
    expect(evidence).toContain("commander")
  })

  it("doctor policy check passes for the built-in policy table", () => {
    const result = doctorCheckRoleToolPolicy()
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("agent registration uses role-tool-policy for read-only reviewers", async () => {
    process.env.DLL_AGENT_ENABLED = "1"
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const roleCross = await load(tmp.path, (svc) => svc.get("role-cross"))
        const finalAuditor = await load(tmp.path, (svc) => svc.get("final-auditor"))
        const multimodal = await load(tmp.path, (svc) => svc.get("multimodal-context-interpreter"))
        const commander = await load(tmp.path, (svc) => svc.get("commander"))
        expect(evalPerm(roleCross, "bash")).toBe("deny")
        expect(evalPerm(roleCross, "edit")).toBe("deny")
        expect(evalPerm(finalAuditor, "task")).toBe("deny")
        expect(evalPerm(multimodal, "bash")).toBe("deny")
        expect(evalPerm(commander, "bash")).toBe("allow")
        expect(evalPerm(commander, "edit")).toBe("allow")
      },
    })
  })
})
