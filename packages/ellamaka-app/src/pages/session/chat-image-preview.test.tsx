import { describe, expect, mock, test } from "bun:test"

mock.module("@wopal/ui/icon", () => ({
  Icon: () => undefined,
}))

const { adjustImagePreviewZoom, imagePreviewZoom, resolveImagePreviewFrameSize } = await import("./chat-image-preview")

describe("ChatImagePreview", () => {
  test("changes zoom in fixed steps without exceeding its supported range", () => {
    expect(adjustImagePreviewZoom(100, 1)).toBe(110)
    expect(adjustImagePreviewZoom(100, -1)).toBe(90)
    expect(adjustImagePreviewZoom(imagePreviewZoom.max, 1)).toBe(imagePreviewZoom.max)
    expect(adjustImagePreviewZoom(imagePreviewZoom.min, -1)).toBe(imagePreviewZoom.min)
  })

  test("keeps a square minimum frame while allowing zoomed images to grow it", () => {
    expect(resolveImagePreviewFrameSize({ width: 160, height: 90 }, 100)).toBe(520)
    expect(resolveImagePreviewFrameSize({ width: 600, height: 300 }, 100)).toBe(632)
    expect(resolveImagePreviewFrameSize({ width: 720, height: 540 }, 200)).toBe(760)
  })

})
