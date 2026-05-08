import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
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

/** Step 1: Pick a role from the role list */
function DialogRoleModelRolePicker(props: { onSelectRole: (role: DllRole) => void }) {
  const dialog = useDialog()

  const options = createMemo(() =>
    ACTIVE_ROLES.map((role) => {
      const effective = resolveRoleModel(role)
      return {
        value: role,
        title: roleLabel(role),
        description: `${effective.primary}${effective.providerAvailable ? "" : " (provider 不可用)"}`,
        footer:
          effective.source !== "built-in"
            ? `${effective.primary} (${sourceLabel(effective.source)})`
            : `${effective.primary}`,
      }
    }),
  )

  return (
    <DialogSelect
      title="选择要切换模型的角色"
      placeholder="搜索角色..."
      options={options()}
      onSelect={(option) => {
        dialog.clear()
        props.onSelectRole(option.value as DllRole)
      }}
    />
  )
}

/** Step 2: Pick a model for the selected role */
function DialogRoleModelModelPicker(props: { role: DllRole }) {
  const sync = useSync()
  const dialog = useDialog()

  const current = createMemo(() => {
    const e = resolveRoleModel(props.role)
    return e.primary
  })

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
        const change = setRoleModelOverride(props.role, model, "global")
        if (change) {
          // Show confirmation — replace with summary dialog
          dialog.replace(() => (
            <DialogRoleModelResult
              role={props.role}
              previousModel={change.previousPrimary}
              newModel={change.newPrimary}
              scope="global"
            />
          ))
        } else {
          dialog.clear()
        }
      }}
    />
  )
}

/** Step 3: Confirmation summary */
function DialogRoleModelResult(props: {
  role: DllRole
  previousModel: string
  newModel: string
  scope: string
}) {
  const dialog = useDialog()

  return (
    <DialogSelect
      title="角色模型已切换"
      options={[
        {
          value: "ok",
          title: `✅ ${roleLabel(props.role)} 模型已更新`,
          description: `${props.previousModel} → ${props.newModel}`,
          footer: `作用域：${sourceLabel(props.scope)}（全局生效，所有 dll-agent 会话均使用此配置）`,
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
  const [step, setStep] = createSignal<"role" | "model">("role")
  const [selectedRole, setSelectedRole] = createSignal<DllRole | null>(null)

  if (step() === "role") {
    return (
      <DialogRoleModelRolePicker
        onSelectRole={(role) => {
          setSelectedRole(role)
          setStep("model")
        }}
      />
    )
  }

  const role = selectedRole()
  if (!role) {
    setStep("role")
    return null
  }

  return <DialogRoleModelModelPicker role={role} />
}
