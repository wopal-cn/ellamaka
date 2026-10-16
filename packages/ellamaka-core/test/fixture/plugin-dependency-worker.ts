import { createInstanceDependencyContributor } from "../../src/plugin-dependencies"

const [, , wopalHome, directory] = process.argv
if (!wopalHome || !directory) throw new Error("usage: plugin-dependency-worker <wopalHome> <directory>")

const contributor = createInstanceDependencyContributor({ wopalHome })
const result = await contributor.prepare(
  { kind: "instance", directory },
  {
    signal: new AbortController().signal,
    report(progress) {
      console.log(JSON.stringify({ type: "progress", phase: progress.phase }))
    },
  },
)
console.log(JSON.stringify({ type: "result", result }))
if (result.state !== "READY") process.exitCode = 1
