/**
 * The CLI binary the SDK launches for `createOpencodeServer`.
 *
 * Inlined rather than imported from `@wopal/ellamaka-brand`: that package is
 * private to the workspace, and a published package must resolve every runtime
 * import from npm. `test/plugin-sdk-branding.test.ts` asserts this value stays
 * equal to the brand package's `BINARY_NAME`.
 */
export const BINARY_NAME = "ellamaka"
