# Serve logging policy

This is the detailed policy behind the logging rules in the repository
`AGENTS.md` ("Logging Rules" and "Debugging Logs"). Update both in the same
change as any logging-behavior edit.

`ellamaka serve` has three separate output channels. They must not be used as
copies of one another:

- The terminal shows the small, user-facing startup contract: listening URL,
  Workbench URL, and actionable warnings.
- The rotating `serve-*.log` file records operator events at `INFO`, warnings,
  and failures. An `INFO` record must describe a state change that needs
  retrospective operator attention (for example, a completed data migration,
  a VCS branch change, or an on-demand dependency install).
- `--log-level DEBUG` is for bounded implementation diagnostics. It must never
  be required to understand normal operation, and it must not carry request,
  prompt, permission-pattern, session, OAuth, or third-party stderr payloads.
- `--trace <categories>` is the opt-in fifth level for the diagnostics
  deliberately removed from INFO/DEBUG. It is never active by default; see
  "Trace" below.

## Trace

`TRACE` is the fifth level, below `DEBUG`. It carries the high-volume lifecycle
records that normal operation must not emit, and is off unless a caller names
the areas it wants.

**The level alone emits nothing.** `--log-level TRACE` without `--trace` is
rejected: "trace everything" is precisely the flood this level exists to
remove. Run `--trace` with no value to list the categories.

The categories are a closed registry (`Log.TraceCategory`). Each covers one of
the areas that historically dominated the serve log; a new category requires a
call site and a line in this document.

| Category     | Covers                                    |
| ------------ | ----------------------------------------- |
| `bus`        | Event-bus publish                         |
| `permission` | Permission decisions and replies          |
| `session`    | Session prompt loop and processor turns   |
| `llm`        | Model/runtime selection per request       |
| `plugin`     | Plugin load, MCP connect, OAuth setup     |
| `io`         | File, formatter, language-server activity |

- `--trace session,llm` enables exactly those categories and promotes the
  effective level to `TRACE`. An explicit `--log-level` still wins, so a
  leftover `--trace` selector cannot silently upgrade an `INFO` run.
- `--trace all` (or `*`) is the explicit escape hatch for all categories.
- An unknown category is an error listing the valid names, never a silent
  widening of the selector.

Trace records are structured and bounded like every other record: each carries
a normalized `category=` marker. They inherit the shared redaction and length
limits.

Trace must never carry raw payloads or user data:

- Bus: the event type only. The published properties (session content, tool
  arguments, message bodies) are not copied.
- Permission: the permission name, the decision `action` (`allow|ask|deny`), an
  `escalated` marker, and a count, plus the `reply` outcome. The evaluated
  pattern, command, path, session id, and pending request contents are never
  written.
- Session/LLM: the step counter and runtime/model identifiers. Message content,
  prompts, and tool arguments are never written.

To emit a trace record from Effect-based code, use the logger bridge
(`EffectLogger.create(...).trace(category, message, extra)`). Effect filters
sub-Info levels before any logger sees them, so the bridge carries the category
as an annotation and routes it to `Log.trace`; do not call `Effect.logTrace`
expecting a trace record.

DSH has only four levels, so the host `TRACE` level is mapped to DSH `DEBUG` at
the boundary. This keeps a `--trace` run from silently dropping DSH diagnostics
while leaving the DSH log contract unchanged.

Do not log event-bus subscription churn, SSE or WebSocket connection churn,
session/message lifecycle events, permission evaluation, question replies,
file-search requests, PTY client lifecycle, or configuration/plugin/provider
enumeration. Those have authoritative state or event streams already; a
second textual copy only creates noise and can expose user data.

For errors from provider SDKs, log only a bounded structured summary. Never
write request bodies, response bodies, credentials, OAuth state, or arbitrary
child-process stderr to the main server log.

## DSH plugin records

DSH plugin severity is not trusted verbatim. Plugins use `error` for a tool
result that the calling agent is already expected to handle; that is not a
host failure.

- Expected tool-policy outcomes — read-before-edit, a missing observed target,
  stale observations, sandbox/approval rejection, and cancellation — are
  redacted `DEBUG` records. The authoritative explanation remains the tool
  result delivered to the agent.
- A retrying plugin is `DEBUG`; one connection attempt must not be an operator
  warning while automatic recovery is still active.
- An unexpected tool execution failure is a redacted `WARN`: the tool name and
  category are retained, but session IDs, call IDs, paths and raw tool errors
  are not copied to the durable plugin log.
- `ERROR` means a capability is actually unavailable (for example, tools were
  unregistered after retries were exhausted) or a plugin reported an
  unrecoverable fault. It carries a fixed reason code rather than an arbitrary
  upstream payload.

The DSH runtime manager and DSH plugin exporter both follow the host log level.
`ellamaka serve --log-level DEBUG` therefore enables their bounded diagnostic
records; normal `serve` keeps routine runtime and plugin activity out of the
operator logs.
