/**
 * Runtime PTY capability probe for the test suite.
 *
 * The PTY tests spawn real pseudoterminals through `bun-pty`'s FFI
 * (`bun_pty_spawn` → `forkpty()`). Environments without process-spawn
 * privileges — sandboxed CI runners, restricted shells — reject `forkpty()`
 * and every PTY case fails with an opaque "PTY spawn failed" 500, even
 * though the code under test is correct. Mirroring the win32 skip, the
 * suite needs a runtime gate: probe the capability once per process and
 * skip the PTY cases when the host cannot create a terminal.
 *
 * The probe performs a real minimal spawn (`/bin/cat`, immediately killed)
 * because the FFI exposes no dry-run; the result is cached so the cost is
 * paid at most once per test process.
 *
 * @module test/fixture/pty
 */
import { spawn } from "bun-pty"

let cached: boolean | undefined

/**
 * Whether this host can spawn a PTY at all. Cheap after the first call;
 * the first call forks and immediately kills one `/bin/cat` process.
 * Never throws — an unexpected probe error counts as "unavailable".
 */
export function ptyAvailable(): boolean {
  if (cached !== undefined) return cached
  try {
    const proc = spawn("/bin/cat", [], { name: "xterm-256color", cols: 80, rows: 24 })
    proc.kill()
    cached = true
  } catch {
    cached = false
  }
  return cached
}
