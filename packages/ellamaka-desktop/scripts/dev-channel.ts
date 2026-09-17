export function resolveDevSidecarChannel(value = process.env.ELLAMAKA_CHANNEL): string {
  return value?.trim() || "local"
}
