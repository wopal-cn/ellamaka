import { expect, test } from "bun:test"
import { SetupServiceError, SpaceServiceError } from "@wopal/wopalspace"
import { toApiError } from "../../src/server/routes/instance/httpapi/wopal-space-errors"

test("public WopalSpace errors preserve HTTP and local error mapping", () => {
  const missing = toApiError(
    new SpaceServiceError({ code: "SPACE_NOT_FOUND", message: "missing https://token@example.com/repo" }),
  )
  expect(missing.constructor.name).toBe("WopalSpaceNotFoundError")
  expect(missing.code).toBe("SPACE_NOT_FOUND")
  expect(missing.message).not.toContain("token@")
  const setup = toApiError(new SetupServiceError({ code: "SETUP_OPERATION_BUSY", message: "busy" }))
  expect(setup.constructor.name).toBe("WopalSpaceConflictError")
  expect(setup.code).toBe("SETUP_OPERATION_BUSY")
})
