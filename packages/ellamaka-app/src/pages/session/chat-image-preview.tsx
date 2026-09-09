import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "@wopal/ui/icon"
import { ImagePreview } from "@wopal/ui/image-preview"

export const imagePreviewZoom = {
  min: 25,
  max: 300,
  step: 10,
  initialMaxWidth: 720,
  initialMaxHeight: 620,
}

type ImageSize = { width: number; height: number }

const imagePreviewFrame = {
  min: 520,
  max: 760,
  padding: 32,
}

function clampZoom(value: number) {
  return Math.min(imagePreviewZoom.max, Math.max(imagePreviewZoom.min, value))
}

export function adjustImagePreviewZoom(current: number, direction: -1 | 1) {
  return clampZoom(current + direction * imagePreviewZoom.step)
}

export function resolveImagePreviewFrameSize(size: ImageSize, scale: number) {
  const scaledEdge = Math.round(Math.max(size.width, size.height) * (scale / 100))
  return Math.min(imagePreviewFrame.max, Math.max(imagePreviewFrame.min, scaledEdge + imagePreviewFrame.padding))
}

function getViewportHeight() {
  return typeof window === "undefined" ? imagePreviewZoom.initialMaxHeight : window.innerHeight
}

export function ChatImagePreviewControls(props: {
  scale: number
  onZoomOut: () => void
  onReset: () => void
  onZoomIn: () => void
}) {
  return (
    <div data-slot="chat-image-preview-controls" role="group" aria-label="Image zoom controls">
      <button
        type="button"
        data-action="chat-image-preview-zoom-out"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={props.scale <= imagePreviewZoom.min}
        on:click={props.onZoomOut}
      >
        <Icon name="dash" size="small" />
      </button>
      <button
        type="button"
        data-action="chat-image-preview-reset-zoom"
        data-slot="chat-image-preview-zoom-level"
        aria-label="Reset image zoom"
        title="Reset image zoom"
        on:click={props.onReset}
      >
        {props.scale}%
      </button>
      <button
        type="button"
        data-action="chat-image-preview-zoom-in"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={props.scale >= imagePreviewZoom.max}
        on:click={props.onZoomIn}
      >
        <Icon name="plus" size="small" />
      </button>
    </div>
  )
}

/**
 * Workbench-only adapter around the shared viewer. Zoom is intentionally
 * transient: it belongs to one open dialog and never changes session state.
 */
export function ChatImagePreview(props: { src: string; alt?: string }) {
  const [scale, setScale] = createSignal(100)
  const [naturalSize, setNaturalSize] = createSignal<ImageSize>()
  const [availableHeight, setAvailableHeight] = createSignal(getViewportHeight())

  onMount(() => {
    const updateAvailableHeight = () => setAvailableHeight(getViewportHeight())
    window.addEventListener("resize", updateAvailableHeight)
    onCleanup(() => window.removeEventListener("resize", updateAvailableHeight))
  })

  createEffect(() => {
    if (typeof Image === "undefined") return
    const image = new Image()
    let disposed = false

    const load = () => {
      if (disposed || !image.naturalWidth || !image.naturalHeight) return
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
    }

    image.addEventListener("load", load)
    image.src = props.src
    if (image.complete) load()

    onCleanup(() => {
      disposed = true
      image.removeEventListener("load", load)
    })
  })

  const fittedSize = createMemo(() => {
    const size = naturalSize()
    if (!size) return
    const maxHeight = Math.max(240, Math.min(imagePreviewZoom.initialMaxHeight, Math.floor(availableHeight() * 0.72) - 64))
    const fit = Math.min(1, imagePreviewZoom.initialMaxWidth / size.width, maxHeight / size.height)
    return {
      width: Math.round(size.width * fit),
      height: Math.round(size.height * fit),
    }
  })

  const previewStyle = createMemo(() => {
    const size = fittedSize()
    if (!size) return undefined
    const multiplier = scale() / 100
    const frameSize = resolveImagePreviewFrameSize(size, scale())
    return {
      "--chat-image-preview-image-width": `${Math.round(size.width * multiplier)}px`,
      "--chat-image-preview-image-height": `${Math.round(size.height * multiplier)}px`,
      "--chat-image-preview-size": `min(${frameSize}px, calc(100vw - 48px), calc(100vh - 48px))`,
      "--chat-image-preview-controls-top": `min(calc(50% + ${Math.round(frameSize / 2 - 40)}px), calc(100vh - 60px))`,
    }
  })

  const adjustZoom = (direction: -1 | 1) => setScale((current) => adjustImagePreviewZoom(current, direction))

  const handleWheel = (event: WheelEvent) => {
    if (!event.deltaY) return
    event.preventDefault()
    adjustZoom(event.deltaY < 0 ? 1 : -1)
  }

  return (
    <div
      data-component="chat-image-preview"
      data-zoom-ready={fittedSize() ? "true" : undefined}
      style={previewStyle()}
      on:wheel={handleWheel}
    >
      <ImagePreview src={props.src} alt={props.alt} />
      <ChatImagePreviewControls
        scale={scale()}
        onZoomOut={() => adjustZoom(-1)}
        onReset={() => setScale(100)}
        onZoomIn={() => adjustZoom(1)}
      />
    </div>
  )
}
