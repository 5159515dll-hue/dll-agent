import { describe, expect, test } from "bun:test"
import { parseRoleModelSetArgs, validateRoleModelSetArgs } from "../../src/dll-agent/role-model-command"

describe("role-model command parsing", () => {
  test("/role-model-set defaults to global scope", () => {
    const parsed = validateRoleModelSetArgs(parseRoleModelSetArgs("commander mimo/mimo-v2.5-pro"))

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.role).toBe("commander")
      expect(parsed.model).toBe("mimo/mimo-v2.5-pro")
      expect(parsed.scope).toBe("global")
    }
  })

  test("/role-model-set keeps explicit session scope when requested", () => {
    const parsed = validateRoleModelSetArgs(parseRoleModelSetArgs("commander deepseek/deepseek-v4-pro --scope session"))

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.scope).toBe("session")
  })
})
