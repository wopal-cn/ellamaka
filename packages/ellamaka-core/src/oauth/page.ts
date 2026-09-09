// Self-contained callback pages for loopback OAuth servers. They deliberately
// contain no external assets so a completed sign-in can render offline.

export interface CallbackPageOptions {
  provider?: string
  autoClose?: boolean
}

export function success(options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization successful",
    body: renderCard({
      heading: "Authorization successful",
      message: provider ? `Ellamaka is now connected to ${escapeHtml(provider)}.` : "Ellamaka is now authorized.",
      detail: undefined,
    }),
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

export function error(detail: string, options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization failed",
    body: renderCard({
      heading: "Authorization failed",
      message: provider
        ? `Ellamaka couldn't finish connecting to ${escapeHtml(provider)}.`
        : "Ellamaka couldn't complete authorization.",
      detail,
    }),
  })
}

export interface BootstrapOptions {
  tokenPath: string
  provider?: string
}

export function bootstrap(options: BootstrapOptions) {
  return renderDocument({
    title: "Finishing sign-in",
    body: renderCard({
      heading: "Finishing sign-in",
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      detail: undefined,
    }),
    script: bootstrapScript(options),
  })
}

export * as OauthCallbackPage from "./page"

function renderCard(input: { heading: string; message: string; detail: string | undefined }) {
  const detail = input.detail?.trim()
  return `<main class="card" role="status" aria-live="polite">
  <h1>${escapeHtml(input.heading)}</h1>
  <p>${input.message}</p>
  <pre${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
  <p class="footnote">You can close this window.</p>
</main>`
}

function renderDocument(input: { title: string; body: string; script?: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · Ellamaka</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

const AUTO_CLOSE_SCRIPT = "setTimeout(function(){try{window.close()}catch(e){}},2500)"

function bootstrapScript(options: BootstrapOptions) {
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var hash=new URLSearchParams((window.location.hash||"").slice(1));
  var search=new URLSearchParams(window.location.search||"");
  var err=hash.get("error")||search.get("error");
  var errDescription=hash.get("error_description")||search.get("error_description");
  var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
  fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
    if(!res.ok)throw new Error("callback failed ("+res.status+")");
    if(!err)setTimeout(function(){try{window.close()}catch(e){}},2500);
  }).catch(function(error){document.querySelector("pre").textContent=String(error&&error.message?error.message:error);document.querySelector("pre").hidden=false});
})()`
}

function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #101010; color: #b7b1b1; }
  .card { width: min(100%, 28rem); box-sizing: border-box; padding: 2rem; border: 1px solid #282828; border-radius: 14px; background: #161616; text-align: center; }
  h1 { margin: 0; color: #f1ecec; font-size: 1.2rem; }
  p { line-height: 1.5; }
  pre { box-sizing: border-box; width: 100%; margin-top: 1rem; padding: .75rem; overflow: auto; white-space: pre-wrap; text-align: left; color: #ff917b; background: #3c140d; border-radius: 8px; }
  .footnote { color: #8f8f8f; font-size: .85rem; }
`
