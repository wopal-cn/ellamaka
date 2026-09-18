/**
 * `@wopal/ellamaka-onboarding` — Ellamaka onboarding server.
 *
 * Exposes the orchestration engine ({@link OnboardingService}), the Node
 * route mount ({@link mountOnboarding}), and the shared contracts. Hosts
 * (opencode serve, the Desktop sidecar) mount the HTTP surface with
 * `server.mountNodeRoute(...)`; frontends talk to it over HTTP/SSE.
 *
 * @module @wopal/ellamaka-onboarding
 */
export { mountOnboarding, type OnboardingMountOptions, type OnboardingRouteHost } from "./mount"
export { createOnboardingRouter, type OnboardingRouter, type OnboardingRouterOptions } from "./router"
export { checkOnboardingAuth, isLoopbackAddress, type OnboardingAuthOptions, type OnboardingAuthResult } from "./auth"
export {
  OnboardingBusyError,
  OnboardingService,
  ONBOARDING_HEALTH_GATE_FAILED,
  ONBOARDING_STEPS,
  ONBOARDING_OPERATION_BUSY,
  createDefaultOnboardingState,
  getOnboardingStatePath,
  getWopalHome,
  isExecutableStep,
  readOnboardingState,
  writeOnboardingState,
  type OnboardingServiceOptions,
} from "./service"
export {
  extractJsonEnvelope,
  installWopalCli,
  resolveWopalCliEntry,
  runSetupOperation,
  terminateChildProcessTree,
  type InstallWopalCliOptions,
  type RunSetupOperationOptions,
} from "./machine-runner"
export type {
  NodeRouteAuth,
  NodeRouteMount,
  OnboardingCompleteResult,
  OnboardingEvent,
  OnboardingExecutableStep,
  OnboardingProbeResult,
  OnboardingProgress,
  OnboardingProgressCallback,
  OnboardingState,
  OnboardingStateView,
  OnboardingStepExecutor,
  OnboardingStepName,
  OnboardingStepResult,
  OnboardingStepStatus,
} from "./types"
