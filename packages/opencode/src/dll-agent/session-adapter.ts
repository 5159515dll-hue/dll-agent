/**
 * Runtime adapter helpers for wiring dll-agent local responses into OpenCode
 * session messages. This keeps prompt.ts focused on orchestration and storage
 * while preserving the native MessageV2 shape.
 */

import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import type { ModelID, ProviderID } from "@/provider/schema"

export interface LocalCommandResponseInput {
  sessionID: SessionID
  command: string
  arguments: string
  agent?: string
  messageID?: MessageID
  providerID: ProviderID
  modelID: ModelID
  cwd: string
  root: string
  text: string
  now?: number
}

export interface LocalCommandResponse {
  user: MessageV2.User
  commandPart: MessageV2.TextPart
  assistant: MessageV2.Assistant
  assistantPart: MessageV2.TextPart
}

export function buildLocalCommandResponse(input: LocalCommandResponseInput): LocalCommandResponse {
  const created = input.now ?? Date.now()
  const user: MessageV2.User = {
    id: input.messageID ?? MessageID.ascending(),
    sessionID: input.sessionID,
    time: { created },
    role: "user",
    agent: input.agent ?? "commander",
    model: { providerID: input.providerID, modelID: input.modelID },
  }
  const commandPart: MessageV2.TextPart = {
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: `/${input.command}${input.arguments ? ` ${input.arguments}` : ""}`,
  }
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    parentID: user.id,
    mode: "commander",
    agent: "commander",
    cost: 0,
    path: { cwd: input.cwd, root: input.root },
    time: { created, completed: created },
    role: "assistant",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.modelID,
    providerID: input.providerID,
  }
  const assistantPart: MessageV2.TextPart = {
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  }
  return { user, commandPart, assistant, assistantPart }
}
