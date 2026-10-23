#!/usr/bin/env bun
import { generateOpenApiJson } from "../src/cli/cmd/generate"

process.stdout.write(await generateOpenApiJson())
