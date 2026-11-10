#!/usr/bin/env bun
import { serverOpenApi } from "../src/server/routes/instance/httpapi/openapi"

/**
 * The complete mounted API document, exactly what GET /doc serves.
 *
 * The public SDK ships only the Public Platform subset of it. Release tooling
 * reads this document to prove the packed SDK contract matches what the Server
 * actually publishes, and that the Official App BFF stays Server-only.
 */
process.stdout.write(JSON.stringify(serverOpenApi(), null, 2))
