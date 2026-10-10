import { initializeNodeDiagnostics } from "./node-diagnostics.js"

// Bun's ESM builtin namespace is established on its first import. Install the
// public diagnostic fallback before any host/UI preload imports node:util.
initializeNodeDiagnostics()
