import { describe, expect, test } from "bun:test"
import { buildLocalCommandResponse } from "../../src/dll-agent/session-adapter"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"

describe("session-adapter", () => {
  test("buildLocalCommandResponse creates native MessageV2 records for local status commands", () => {
    const response = buildLocalCommandResponse({
      sessionID: SessionID.make("session_test"),
      command: "task-status",
      arguments: "",
      agent: "commander",
      messageID: MessageID.make("message_user"),
      providerID: ProviderID.make("deepseek"),
      modelID: ModelID.make("deepseek-v4-pro"),
      cwd: "/repo",
      root: "/repo",
      text: "dll-agent task status",
      now: 123,
    })

    expect(response.user.id).toBe(MessageID.make("message_user"))
    expect(response.commandPart.messageID).toBe(response.user.id)
    expect(response.commandPart.text).toBe("/task-status")
    expect(response.assistant.parentID).toBe(response.user.id)
    expect(response.assistant.cost).toBe(0)
    expect(response.assistant.providerID).toBe(ProviderID.make("deepseek"))
    expect(response.assistant.modelID).toBe(ModelID.make("deepseek-v4-pro"))
    expect(response.assistantPart.messageID).toBe(response.assistant.id)
    expect(response.assistantPart.text).toBe("dll-agent task status")
  })

  test("buildLocalCommandResponse preserves command arguments for auditability", () => {
    const response = buildLocalCommandResponse({
      sessionID: SessionID.make("session_test"),
      command: "role-model-set",
      arguments: "commander deepseek/deepseek-v4-pro --scope session",
      providerID: ProviderID.make("deepseek"),
      modelID: ModelID.make("deepseek-v4-pro"),
      cwd: "/repo",
      root: "/repo",
      text: "updated",
      now: 123,
    })

    expect(response.commandPart.text).toBe("/role-model-set commander deepseek/deepseek-v4-pro --scope session")
    expect(response.user.agent).toBe("commander")
    expect(response.assistant.agent).toBe("commander")
  })
})
