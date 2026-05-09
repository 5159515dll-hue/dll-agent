import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import {
  getPermissionMode,
  permissionModeOptions,
  setPermissionMode,
  type DllPermissionMode,
} from "@/dll-agent/permission-mode"

export function DialogPermissions() {
  const dialog = useDialog()
  const current = getPermissionMode()
  return (
    <DialogSelect
      title="dll-agent permissions"
      current={current}
      options={permissionModeOptions().map((option) => ({
        value: option.mode,
        title: `${option.label}${option.mode === current ? " (current)" : ""}`,
        description: option.description,
      }))}
      onSelect={(option) => {
        setPermissionMode(option.value as DllPermissionMode)
        dialog.clear()
      }}
    />
  )
}
