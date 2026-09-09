export const ellamaka = {
  left: [
    "                 ",
    "█▀▀▀ █   █   █▀▀█",
    "█▀▀▀ █   █   █▀▀█",
    "▀▀▀▀ ▀▀▀ ▀▀▀ ▀  ▀",
  ],
  right: [
    "                    ",
    "█▀▀▀█ █▀▀█ █  ▀ █▀▀█",
    "█ ▀ █ █▀▀█ █▀▀  █▀▀█",
    "▀ ▀ ▀ ▀  ▀ ▀  ▀ ▀  ▀",
  ],
}

export const wordmark = ellamaka.left.map((l, i) => l + " " + ellamaka.right[i])

