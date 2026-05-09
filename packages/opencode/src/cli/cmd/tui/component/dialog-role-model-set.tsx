import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { useRoute } from "@tui/context/route"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import {
  ACTIVE_ROLES,
  resolveRoleModel,
  setRoleModelOverride,
  validateRoleModel,
  type DllRole,
} from "@/dll-agent/role-model-registry"

function roleLabel(role: DllRole): string {
  const labels: Partial<Record<DllRole, string>> = {
    commander: "主执行模型",
    "chief-engineer": "工程审查模型",
    "requirements-inspector": "需求一致性审查模型",
    "long-context-archivist": "长上下文归档模型",
    "task-completion-archivist": "任务收尾检查模型",
    "final-auditor": "最终审计模型",
    "role-cross": "角色冲突仲裁模型",
    "multimodal-context-interpreter": "多模态上下文解释模型",
    executor: "验证执行器",
  }
  return labels[role] ?? role
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    "built-in": "内置默认",
    global: "全局配置",
    project: "项目配置",
    session: "会话覆盖",
  }
  return labels[source] ?? source
}

/** Step 1: Pick a role */
function RolePicker() {
  const dialog = useDialog()
  const route = useRoute()
  const project = useProject()

  const options = createMemo(() =>
    ACTIVE_ROLES.map((role) => {
      const effective = resolveRoleModel(
        role,
        route.data.type === "session" ? route.data.sessionID : undefined,
        project.instance.path().worktree || project.instance.directory(),
      )
      return {
        value: role,
        title: roleLabel(role),
        description: `${effective.primary}${effective.providerAvailable ? "" : " (provider 不可用)"}`,
        footer: `${effective.primary}${effective.source !== "built-in" ? ` (${sourceLabel(effective.source)})` : ""}`,
      }
    }),
  )

  return (
    <DialogSelect
      title="选择要切换模型的角色"
      placeholder="搜索角色..."
      options={options()}
      onSelect={(option) => {
        const role = option.value as DllRole
        dialog.replace(() => <ModelPicker role={role} />)
      }}
    />
  )
}

/** Step 2: Pick a model — shows ALL available models like /models */
function ModelPicker(props: { role: DllRole }) {
  const sync = useSync()
  const dialog = useDialog()
  const route = useRoute()
  const project = useProject()
  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const projectDir = createMemo(() => project.instance.path().worktree || project.instance.directory())
  const scope = createMemo(() => (sessionID() ? "session" : projectDir() ? "project" : "global"))

  const current = createMemo(() => resolveRoleModel(props.role, sessionID(), projectDir()).primary)

  const options = createMemo(() => {
    const results: { value: string; title: string; description: string; category: string }[] = []
    for (const provider of sync.data.provider) {
      for (const [model, info] of Object.entries(provider.models)) {
        if (info.status === "deprecated") continue
        results.push({
          value: `${provider.id}/${model}`,
          title: info.name ?? model,
          description: provider.name,
          category: provider.name,
        })
      }
    }
    return results
  })

  return (
    <DialogSelect
      title={`为「${roleLabel(props.role)}」选择模型`}
      current={current()}
      placeholder="搜索模型..."
      options={options()}
      onSelect={(option) => {
        const model = option.value as string
        if (!validateRoleModel(model).valid) return
        const change = setRoleModelOverride(props.role, model, scope() as "session" | "project" | "global", sessionID(), projectDir())
        dialog.replace(() => (
          <Confirmation
            role={props.role}
            previousModel={change?.previousPrimary ?? current()}
            newModel={model}
            success={!!change}
            scope={scope()}
          />
        ))
      }}
    />
  )
}

/** Step 3: Confirmation */
function Confirmation(props: {
  role: DllRole
  previousModel: string
  newModel: string
  success: boolean
  scope: string
}) {
  const dialog = useDialog()

  return (
    <DialogSelect
      title={props.success ? "角色模型已切换" : "切换失败"}
      options={[
        {
          value: "ok",
          title: props.success
            ? `✅ ${roleLabel(props.role)} 模型已更新`
            : `❌ ${roleLabel(props.role)} 模型切换失败`,
          description: props.success
            ? `${props.previousModel} → ${props.newModel}`
            : `未能写入配置：${props.newModel}`,
          footer: props.success ? `作用域：${sourceLabel(props.scope)}` : undefined,
        },
        {
          value: "done",
          title: "关闭",
          description: "按 Enter 或 Esc 关闭",
        },
      ]}
      onSelect={() => dialog.clear()}
    />
  )
}

export function DialogRoleModelSet() {
  return <RolePicker />
}
