import { mock } from "bun:test"

void mock.module("./something", () => ({ ok: true }))
