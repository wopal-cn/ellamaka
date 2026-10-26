// Initializing Bun's output streams sets O_NONBLOCK on inherited descriptors.
// The exec bootstrap must not pass those runtime flags to an ordinary target.
process.stdout.write("")
process.stderr.write("")
