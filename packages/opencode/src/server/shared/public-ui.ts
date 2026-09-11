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

// The Workbench HTML document itself. A reload (F5) re-navigates to
// `/workbench` AFTER the SPA has stripped `?auth_token=` from the URL, so the
// document request carries no credential and a 401 + `www-authenticate` pops
// the browser's native login dialog — the exact document-level failure the
// asset exemptions above prevent for `<script src>`. The shell carries no
// server state (same argument as the assets): every data route underneath
// (`/workbench/dsh-url`, `/workbench/locations`, …) stays authenticated, and
// the SPA re-hydrates its persisted credentials once booted. `/` serves the
// same embedded index through the UI catch-all.
const PUBLIC_UI_DOCUMENTS = new Set<string>(["/", "/workbench"])

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  if (PUBLIC_UI_DOCUMENTS.has(pathname)) return true
  if (PUBLIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return PUBLIC_UI_ROOT_FILES.has(pathname)
}
