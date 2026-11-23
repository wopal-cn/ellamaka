# warn-report.awk — the diagnostics from one build step, one per line.
#
# Two input shapes, one output contract:
#
#   default      vite/rollup stderr. electron-vite runs with --logLevel warn,
#                so every line left after the noise rules is a diagnostic.
#   -v colored=1 electron-builder stdout. It writes progress and diagnostics to
#                the same stream and only colour separates them, so keep yellow
#                (warn) and red (error) lines and drop everything else.
#
# Both modes drop the `$ <command>` banner, blank lines, vite code frames
# (source snippets printed under a warning), and the bare
# `[plugin vite:reporter]` separator whose `(!)` line carries the content.
#
# Usage: awk -v root="$PROJECT_ROOT/" [-v colored=1] -f warn-report.awk <file>

BEGIN {
  esc = sprintf("%c", 27)
}

/^[[:space:]]*$/                              { next }
/^\$ /                                        { next }
/^\[plugin vite:reporter\][[:space:]]*$/      { next }
/^[[:space:]]*[0-9]+[[:space:]]*\|/           { next }
/^[[:space:]]*\|/                             { next }

{
  line = $0

  # electron-builder: keep only warn/error lines, then strip the colour codes.
  if (colored) {
    if (line !~ (esc "\\[33m") && line !~ (esc "\\[31m")) next
    gsub(esc "\\[[0-9;]*m", "", line)
  }

  # Absolute paths -> project-relative.
  if (root != "") gsub(root, "", line)

  print line
}
