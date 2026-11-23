const INTERACTIVE_END_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="dialog"]',
  ".xterm",
  '[data-component="terminal"]',
  '[data-component="prompt-input"]',
].join(", ")

const TRANSCRIPT_NAVIGATOR_CONTROLS = [
  '[data-slot="chat-prompt-item"]',
  '[data-slot="chat-prompt-tick"]',
  '[data-component="chat-prompt-directory-trigger"]',
].join(", ")

export type ChatTranscriptNavigation = "first" | "previous" | "next" | "latest"

/**
 * Keeps native editing, selection and platform-shortcut meanings intact. Only
 * unmodified navigation keys from the transcript may control the chat timeline.
 */
export function chatTranscriptNavigation(event: KeyboardEvent): ChatTranscriptNavigation | undefined {
  const navigation: Record<string, ChatTranscriptNavigation> = {
    Home: "first",
    PageUp: "previous",
    PageDown: "next",
    End: "latest",
  }
  const action = navigation[event.key]
  if (
    !action ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return undefined
  }

  const target = event.target
  const prompt =
    target instanceof HTMLElement ? target.closest<HTMLElement>('[data-component="prompt-input"]') : undefined
  // The active Workbench chat normally restores focus to an empty composer.
  // With no draft to navigate, transcript navigation is more useful than a
  // browser caret/page shortcut; any text or attachment keeps the editor's
  // native behavior.
  if (prompt) return prompt.textContent?.trim() ? undefined : action

  // Prompt-directory buttons intentionally retain focus after a jump. They
  // are navigation controls, not an editor, so the same shortcut must remain
  // available without requiring the user to click the transcript first.
  if (target instanceof HTMLElement && target.closest(TRANSCRIPT_NAVIGATOR_CONTROLS)) return action

  if (target instanceof HTMLElement && target.closest(INTERACTIVE_END_TARGETS)) return undefined

  const selection = document.getSelection()
  return !selection || selection.isCollapsed ? action : undefined
}

/** Compatibility helper for the existing End-specific unit coverage. */
export function shouldResumeChatOnEnd(event: KeyboardEvent): boolean {
  return chatTranscriptNavigation(event) === "latest"
}
