type TerminalImeFrameInput = {
  cursorX: number
  cursorY: number
  cellWidth: number
  cellHeight: number
  paddingLeft: number
  paddingTop: number
}

export function getTerminalImeFrame(input: TerminalImeFrameInput) {
  return {
    left: `${input.paddingLeft + input.cursorX * input.cellWidth}px`,
    top: `${input.paddingTop + input.cursorY * input.cellHeight}px`,
    width: `${input.cellWidth}px`,
    height: `${input.cellHeight}px`,
    opacity: "0.01",
  }
}

export type TerminalImeComposition = {
  active: boolean
  text: string
}

type TerminalImeCompositionEvent = { type: "start" | "update" | "end"; data: string } | { type: "blur" }

export function updateTerminalImeComposition(
  current: TerminalImeComposition | undefined,
  event: TerminalImeCompositionEvent,
): TerminalImeComposition {
  if (event.type === "blur" || event.type === "end") return { active: false, text: "" }
  if (event.type === "start") return { active: true, text: event.data }
  return { active: current?.active ?? true, text: event.data }
}
