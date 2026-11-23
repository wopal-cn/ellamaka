import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { useLanguage } from "@/context/language"
import { useDialog } from "@wopal/ui/context/dialog"

export function WorkbenchSettingsButton() {
  const language = useLanguage()
  const dialog = useDialog()
  const t = (k: string) => language.t(k)

  function openSettings() {
    void import("@/components/dialog-settings").then((x) => {
      void dialog.show(() => <x.DialogSettings />)
    })
  }

  return (
    <IconButtonV2
      variant="ghost-muted"
      size="small"
      icon={<IconV2 name="settings-gear" />}
      aria-label={t("workbench.settings.title")}
      onClick={openSettings}
    />
  )
}
