/**
 * Pure planner for supervisor reviewer dispatch batches.
 *
 * prompt.ts still performs Effect execution and session mutation. This module
 * keeps the read-only parallel vs write-capable serial grouping rule testable.
 */

import type { MessageV2 } from "@/session/message-v2"

export interface ReviewerDispatchGroup {
  mode: "parallel-read" | "serial-write"
  tasks: MessageV2.SubtaskPart[]
}

export function isSupervisorSubtask(task: MessageV2.Part | undefined): task is MessageV2.SubtaskPart {
  return task?.type === "subtask" && task.command === "dll-agent-supervisor"
}

export function drainSupervisorDispatchBatch(tasks: MessageV2.Part[]): MessageV2.SubtaskPart[] {
  const batch: MessageV2.SubtaskPart[] = []
  while (tasks.length > 0) {
    const tail = tasks[tasks.length - 1]
    if (!isSupervisorSubtask(tail)) break
    batch.push(tasks.pop() as MessageV2.SubtaskPart)
  }
  return batch
}

export function planReviewerDispatchGroups(
  batch: MessageV2.SubtaskPart[],
  isReadOnly: (agent: string) => boolean,
): ReviewerDispatchGroup[] {
  const groups: ReviewerDispatchGroup[] = []
  let index = 0
  while (index < batch.length) {
    const current = batch[index]
    if (!isReadOnly(current.agent)) {
      groups.push({ mode: "serial-write", tasks: [current] })
      index++
      continue
    }

    const readOnlyGroup: MessageV2.SubtaskPart[] = []
    while (index < batch.length && isReadOnly(batch[index].agent)) {
      readOnlyGroup.push(batch[index])
      index++
    }
    groups.push({ mode: "parallel-read", tasks: readOnlyGroup })
  }
  return groups
}
