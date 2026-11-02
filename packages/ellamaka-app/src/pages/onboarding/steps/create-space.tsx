import { createComputed, createSignal, For, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ResultPanel } from "../components/ResultPanel"
import type { SetupInspect } from "../setup-client"

export interface CreateSpaceInput {
  name: string
  path: string
  type: string
}

export interface CreateSpaceStepProps {
  facts: SetupInspect
  working: boolean
  defaultPath?: string
  onRun: (input: CreateSpaceInput) => void
}

function spaceNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "space"
}

type AvailableSpaceType = SetupInspect["space"]["availableTypes"][number]

export function createSpaceFormState(availableTypes: () => readonly AvailableSpaceType[], defaultPath = "") {
  const [spacePath, setSpacePath] = createSignal(defaultPath)
  const [spaceName, setSpaceName] = createSignal("")
  const [spaceType, setSpaceType] = createSignal(availableTypes()[0]?.type ?? "")
  const [formError, setFormError] = createSignal<string | null>(null)

  createComputed(() => {
    const types = availableTypes()
    if (types.length === 0) return
    if (!types.some((item) => item.type === spaceType())) setSpaceType(types[0]?.type ?? "")
  })

  return { spacePath, setSpacePath, spaceName, setSpaceName, spaceType, setSpaceType, formError, setFormError }
}

export function CreateSpaceStep(props: CreateSpaceStepProps) {
  const platform = usePlatform()
  const availableTypes = () => props.facts.space.availableTypes
  const form = createSpaceFormState(availableTypes, props.defaultPath ?? "")
  const { spacePath, setSpacePath, spaceName, setSpaceName, spaceType, setSpaceType, formError, setFormError } = form

  const verified = () => props.facts.space.items.filter((item) => item.verified)
  const selectedType = () => availableTypes().find((item) => item.type === spaceType())

  const submit = (event: Event) => {
    event.preventDefault()
    if (props.working || verified().length > 0) return
    const path = spacePath().trim()
    if (!path) {
      setFormError("请选择或输入空间目录。")
      return
    }
    if (!spaceType()) {
      setFormError("能力本体中没有可用的空间类型，请先检查本体。")
      return
    }
    setFormError(null)
    props.onRun({
      path,
      name: spaceName().trim() || spaceNameFromPath(path),
      type: spaceType().trim() || "coding",
    })
  }

  const browse = async () => {
    if (!platform.openDirectoryPickerDialog) return
    try {
      const result = await platform.openDirectoryPickerDialog({ title: "选择工作空间根目录" })
      const selected = typeof result === "string" ? result : Array.isArray(result) ? result[0] : undefined
      if (selected) {
        setSpacePath(selected)
        setFormError(null)
      }
    } catch {
      // Dialog cancellation is not an error.
    }
  }

  return (
    <form id="onboarding-step-create-space" onSubmit={submit} class="ob-step-content">
      <Show when={verified().length > 0}>
        <ResultPanel title="已检测到可用的工作空间">
          <div class="ob-result-details">
            <For each={verified()}>
              {(item) => (
                <div class="ob-result-row">
                  <span class="ob-result-label">{item.name}</span>
                  <span class="ob-result-value ob-result-location">{item.path}</span>
                </div>
              )}
            </For>
          </div>
        </ResultPanel>
      </Show>

      <Show when={verified().length === 0}>
        <div class="ob-form-group">
          <label class="ob-label" for="space-root-input">
            空间目录
          </label>
          <input
            id="space-root-input"
            class="ob-input"
            value={spacePath()}
            placeholder="例如 ~/WopalSpace/my-space"
            disabled={props.working}
            onInput={(event) => {
              setSpacePath(event.currentTarget.value)
              setFormError(null)
            }}
          />
          <Show when={platform.openDirectoryPickerDialog !== undefined}>
            <button type="button" class="ob-button ob-button-secondary" onClick={browse} disabled={props.working}>
              选择目录…
            </button>
          </Show>
        </div>
        <div class="ob-form-group">
          <label class="ob-label" for="space-name-input">
            空间名称
          </label>
          <input
            id="space-name-input"
            class="ob-input"
            value={spaceName()}
            placeholder={spacePath() ? spaceNameFromPath(spacePath()) : "留空则使用目录名称"}
            disabled={props.working}
            onInput={(event) => setSpaceName(event.currentTarget.value)}
          />
        </div>
        <div class="ob-form-group">
          <label class="ob-label" for="space-type-input">
            空间类型
          </label>
          <select
            id="space-type-input"
            class="ob-input"
            value={spaceType()}
            disabled={props.working}
            onInput={(event) => setSpaceType(event.currentTarget.value)}
          >
            <For each={availableTypes()}>{(entry) => <option value={entry.type}>{entry.type}</option>}</For>
          </select>
          <Show when={selectedType()?.description}>
            {(description) => <span class="ob-field-help">{description()}</span>}
          </Show>
          <Show when={availableTypes().length === 0}>
            <span class="ob-field-error">能力本体中没有检测到可用的 assembly/archetypes。</span>
          </Show>
        </div>
        <Show when={formError()}>
          <p class="ob-field-error">{formError()}</p>
        </Show>
      </Show>
    </form>
  )
}
