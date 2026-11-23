// Window show guard: guarantees a hidden window becomes visible even when
// the GPU-composited first frame never completes (e.g. VMware SVGA 3D virtual
// GPU on Windows, where `ready-to-show` never fires). Pure helpers so the
// logic is unit-testable without a real BrowserWindow.

export interface WindowShowGuard {
  // Show the window if it is alive and not visible. Idempotent and safe.
  showIfNeeded: () => void
  // Clear the fallback timer (called on ready-to-show and window closed).
  cancel: () => void
}

interface WindowLike {
  isDestroyed: () => boolean
  isVisible: () => boolean
  show: () => void
  focus: () => void
}

export function createWindowShowGuard(
  win: { isDestroyed: () => boolean; isVisible: () => boolean; show: () => void },
  fallbackMs = 5000,
): WindowShowGuard {
  let timer: ReturnType<typeof setTimeout> | null = null

  const showIfNeeded = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (win.isDestroyed() || win.isVisible()) return
    win.show()
  }

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  timer = setTimeout(showIfNeeded, fallbackMs)

  return { showIfNeeded, cancel }
}

// Second-instance recovery: show + focus an existing live window, otherwise
// create a fresh one via the provided factory. Returns the live window.
export function recoverMainWindow<T extends WindowLike>(current: T | null, createWindow: () => T): T {
  if (current && !current.isDestroyed()) {
    current.show()
    current.focus()
    return current
  }
  return createWindow()
}
