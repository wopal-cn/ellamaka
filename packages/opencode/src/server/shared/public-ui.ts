// Static UI assets the browser fetches without app-managed credentials.
// These bypass auth so a password-protected Workbench can boot at all: the
// HTML references its bundle through hashed `<script src>` / `<link href>`
// tags that cannot carry an Authorization header, and a 401 with
// `www-authenticate: Basic` on them pops the browser's native login dialog —
// unreachable from inside the SPA. The assets carry no server state (their
// hashes are unknowable to a client beforehand); every API route stays
// authenticated.
const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

// Hashed Vite build output and root-level static files the Workbench HTML
// references (favicons, logos, theme preload). Prefix match covers /assets/;
// the root files are the fixed set shipped in the app's public/ directory.
const PUBLIC_UI_PREFIXES = ["/assets/"]

const PUBLIC_UI_ROOT_FILES = new Set<string>([
  "/apple-touch-icon.png",
  "/ellamaka-text-logo.png",
  "/favicon-96x96.png",
  "/favicon.ico",
  "/favicon.svg",
  "/oc-theme-preload.js",
  "/social-share-zen.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  if (PUBLIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return PUBLIC_UI_ROOT_FILES.has(pathname)
}
