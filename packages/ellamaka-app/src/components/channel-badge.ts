// Whether the channel badge should be shown in the titlebar.
// Vocabulary semantics: show on any non-stable channel (main/local/beta),
// hide on stable and when the channel is undefined (dev fallback).
export function shouldShowChannelIndicator(channel: string | undefined): boolean {
  return channel !== undefined && channel !== "stable"
}
