import { createSignal, Show } from "solid-js"
import { Button } from "@wopal/ui/button"
import { useDialog } from "@wopal/ui/context/dialog"
import { Dialog } from "@wopal/ui/dialog"
import { useLanguage } from "@/context/language"
import type { WopalCliHealth } from "@/utils/server-health"

export function CliRepairDialog(props: {
  cli: WopalCliHealth
  repair: () => Promise<boolean>
  onRepaired: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [repairing, setRepairing] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  const repair = async () => {
    if (repairing()) return
    setRepairing(true)
    setFailed(false)
    try {
      if (!await props.repair()) {
        setFailed(true)
        return
      }
      props.onRepaired()
      dialog.close()
    } finally {
      setRepairing(false)
    }
  }

  return (
    <Dialog title={language.t("workbench.cli.repair.title")} fit>
      <div class="flex min-w-[360px] flex-col gap-4 pb-3 pl-6 pr-2.5">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("workbench.cli.repair.message", { required: props.cli.requiredVersion })}
          </span>
          <span class="text-12-regular text-text-muted">
            {language.t("workbench.cli.repair.hint")}
          </span>
        </div>
        <Show when={failed()}>
          <span class="text-12-regular text-icon-critical-base">{language.t("workbench.cli.repair.failed")}</span>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={repairing()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={repairing()} onClick={() => void repair()}>
            {repairing() ? language.t("workbench.status.diagnostics.retrying") : language.t("workbench.cli.repair.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
