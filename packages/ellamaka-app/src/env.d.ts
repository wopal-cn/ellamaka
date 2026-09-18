interface ImportMetaEnv {
  readonly VITE_ELLAMAKA_SERVER_HOST: string
  readonly VITE_ELLAMAKA_SERVER_PORT: string
  readonly ELLAMAKA_CHANNEL?: "stable" | "beta" | "main" | "local"

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
